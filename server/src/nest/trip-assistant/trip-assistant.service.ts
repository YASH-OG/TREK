import { Injectable } from '@nestjs/common';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type { Trip, TripAssistantDraft, TripAssistantRequest, TripAssistantResponse, TripAssistantSession, TripCreateRequest } from '@trek/shared';
import { tripAssistantDraftSchema, tripAssistantRequestSchema, tripAssistantResponseSchema, tripAssistantSessionSchema } from '@trek/shared';
import type { User } from '../../types';
import { TripsService } from '../trips/trips.service';
import { TripAssistantStore } from './trip-assistant.store';

const modelResponseSchema = z.object({
  assistant_message: z.string().min(1),
  draft: tripAssistantDraftSchema.default({}),
  ready_to_create: z.boolean(),
  missing_fields: z.array(z.string()).default([]),
});

const BASE_PROMPT = `You are TREK's travel assistant. Help the user create a trip in the existing app by conversationally filling the trip fields.

Return concise, helpful replies in the user's language when possible.

Rules:
- Keep the user's trip data aligned to the existing TREK trip form.
- Required trip payload fields are title and optionally description, start_date, end_date, currency, reminder_days, and day_count.
- Use ISO dates in YYYY-MM-DD when dates are known.
- If the user gives a duration without dates, use day_count.
- If the user has not given enough detail, ask one clarifying question at a time.
- Set ready_to_create to true only when the user has given enough detail and it is reasonable to create the trip now.
- Never invent details the user did not provide; if something is unknown, leave it null or omit it from the draft.
- When the user is asking to create a trip, surface the draft in a natural reply and keep the output JSON valid.`;

function clampDayCount(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(365, Math.max(1, Math.floor(num)));
}

function normalizeDraft(draft: TripAssistantDraft): TripAssistantDraft {
  return {
    title: typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : draft.destination?.trim() || undefined,
    description: typeof draft.description === 'string' && draft.description.trim() ? draft.description.trim() : undefined,
    start_date: typeof draft.start_date === 'string' && draft.start_date.trim() ? draft.start_date.trim() : undefined,
    end_date: typeof draft.end_date === 'string' && draft.end_date.trim() ? draft.end_date.trim() : undefined,
    currency: typeof draft.currency === 'string' && draft.currency.trim() ? draft.currency.trim().toUpperCase() : undefined,
    reminder_days: clampDayCount(draft.reminder_days) ?? undefined,
    day_count: clampDayCount(draft.day_count) ?? undefined,
    destination: typeof draft.destination === 'string' && draft.destination.trim() ? draft.destination.trim() : undefined,
    travelers: clampDayCount(draft.travelers) ?? undefined,
    budget: typeof draft.budget === 'number' && Number.isFinite(draft.budget) ? draft.budget : undefined,
    style: typeof draft.style === 'string' && draft.style.trim() ? draft.style.trim() : undefined,
    notes: typeof draft.notes === 'string' && draft.notes.trim() ? draft.notes.trim() : undefined,
  };
}

function mergeDraft(previous: TripAssistantDraft, next: TripAssistantDraft): TripAssistantDraft {
  return normalizeDraft({ ...previous, ...next });
}

function buildTripCreatePayload(draft: TripAssistantDraft): TripCreateRequest | null {
  const title = typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : '';
  if (!title) return null;
  const payload: TripCreateRequest = {
    title,
    description: typeof draft.description === 'string' && draft.description.trim() ? draft.description.trim() : null,
    currency: typeof draft.currency === 'string' && draft.currency.trim() ? draft.currency.trim().toUpperCase() : 'EUR',
  };
  if (typeof draft.start_date === 'string' && draft.start_date.trim()) payload.start_date = draft.start_date.trim();
  if (typeof draft.end_date === 'string' && draft.end_date.trim()) payload.end_date = draft.end_date.trim();
  const reminderDays = clampDayCount(draft.reminder_days);
  if (reminderDays !== null) payload.reminder_days = reminderDays;
  const dayCount = clampDayCount(draft.day_count);
  if (dayCount !== null && !payload.start_date && !payload.end_date) payload.day_count = dayCount;
  return payload;
}

function computeMissingFields(draft: TripAssistantDraft): string[] {
  const missing: string[] = [];
  if (!draft.title) missing.push('title');
  if (!draft.destination && !draft.start_date && !draft.end_date) missing.push('destination or dates');
  return missing;
}

function buildPrompt(input: TripAssistantRequest, session: TripAssistantSession): string {
  const timeZone = input.timezone || 'UTC';
  const locale = input.locale || 'en';
  return `${BASE_PROMPT}

Locale: ${locale}
Time zone: ${timeZone}

Current draft:
${JSON.stringify(session.draft ?? {}, null, 2)}

If the current draft already has enough detail to create a useful trip and the user is asking to proceed, set ready_to_create to true. Otherwise, ask for the single most important missing detail.`;
}

@Injectable()
export class TripAssistantService {
  private readonly model: ChatOpenAI | null;

  constructor(
    private readonly store: TripAssistantStore,
    private readonly trips: TripsService,
  ) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.OPENROUTER_MODEL?.trim() || 'openai/gpt-4o-mini';
    const baseURL = process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
    this.model = apiKey
      ? new ChatOpenAI({
          apiKey,
          model,
          temperature: 0.25,
          configuration: { baseURL },
        })
      : null;
  }

  async getSession(user: User, sessionId: string): Promise<TripAssistantSession> {
    const session = await this.store.loadOrCreate(sessionId, user.id);
    return tripAssistantSessionSchema.parse(session);
  }

  async handleMessage(user: User, input: TripAssistantRequest): Promise<TripAssistantResponse> {
    const parsed = tripAssistantRequestSchema.parse(input);
    const session = await this.store.loadOrCreate(parsed.session_id, user.id);

    const history = session.messages.slice(-12).map((message) => (
      message.role === 'user'
        ? new HumanMessage(message.content)
        : new AIMessage(message.content)
    ));
    const prompt = buildPrompt(parsed, session);
    const structured = this.model?.withStructuredOutput(modelResponseSchema, { name: 'trip_assistant_response' });

    const modelOutput = structured
      ? await structured.invoke([
          new SystemMessage(prompt),
          ...history,
          new HumanMessage(parsed.message),
        ])
      : this.fallbackOutput(parsed.message, session);

    const mergedDraft = mergeDraft(session.draft, modelOutput.draft);
    const createPayload = buildTripCreatePayload(mergedDraft);
    const readyToCreate = Boolean(modelOutput.ready_to_create && createPayload && !session.created_trip_id);
    const messages = [
      ...session.messages,
      { role: 'user' as const, content: parsed.message },
      { role: 'assistant' as const, content: modelOutput.assistant_message },
    ];

    let createdTrip = session.created_trip ?? null;
    let createdTripId = session.created_trip_id ?? null;
    let assistantMessage = modelOutput.assistant_message;

    if (readyToCreate && createPayload) {
      const result = this.trips.create(user.id, createPayload);
      createdTrip = result.trip as Trip;
      createdTripId = createdTrip && typeof createdTrip.id === 'number' ? createdTrip.id : createdTripId;
      if (createdTrip && typeof createdTrip.title === 'string') {
        assistantMessage = `${assistantMessage}\n\nI created “${createdTrip.title}” in TREK.`;
      }
    }

    const nextSession: TripAssistantSession = {
      session_id: session.session_id,
      messages: [...session.messages, { role: 'user', content: parsed.message }, { role: 'assistant', content: assistantMessage }],
      draft: mergedDraft,
      created_trip_id: createdTripId,
      created_trip: createdTrip,
    };
    await this.store.save(nextSession, user.id);

    return tripAssistantResponseSchema.parse({
      ...nextSession,
      assistant_message: assistantMessage,
      ready_to_create: readyToCreate,
      missing_fields: computeMissingFields(mergedDraft),
    });
  }

  private fallbackOutput(message: string, session: TripAssistantSession): z.infer<typeof modelResponseSchema> {
    const lower = message.toLowerCase();
    const nextDraft = mergeDraft(session.draft, {
      title: session.draft.title || (lower.includes('trip') ? message.trim().slice(0, 64) : undefined),
      notes: message.trim(),
    });
    return {
      assistant_message: nextDraft.title
        ? `I can build that trip. What dates should I use for ${nextDraft.title}?`
        : 'Tell me the destination or the trip name, and I will start building it.',
      draft: nextDraft,
      ready_to_create: Boolean(nextDraft.title && (nextDraft.start_date || nextDraft.end_date || nextDraft.day_count || nextDraft.destination)),
      missing_fields: computeMissingFields(nextDraft),
    };
  }
}