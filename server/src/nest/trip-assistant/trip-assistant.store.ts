import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import type { Trip, TripAssistantDraft, TripAssistantMessage, TripAssistantSession } from '@trek/shared';

interface AssistantState {
  messages: TripAssistantMessage[];
  draft: TripAssistantDraft;
}

interface SessionRecord {
  id: string;
  userId: number;
  state: AssistantState;
  createdTripId: number | null;
  createdTrip: Trip | null;
}

@Injectable()
export class TripAssistantStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripAssistantStore.name);
  private readonly useNeon = Boolean(process.env.AI_NEON_DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim());
  private readonly memory = new Map<string, SessionRecord>();
  private client: Sql | null = null;

  async onModuleInit(): Promise<void> {
    if (this.useNeon) {
      await this.ensureSchema();
    } else {
      this.logger.warn('AI assistant storage is using in-memory fallback because AI_NEON_DATABASE_URL is not set.');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.end({ timeout: 5 });
      this.client = null;
    }
  }

  async loadOrCreate(sessionId: string | undefined, userId: number): Promise<TripAssistantSession> {
    if (this.useNeon) {
      if (sessionId) {
        const row = await this.getNeonSession(sessionId, userId);
        if (row) return row;
      }
      return this.createNeonSession(userId);
    }

    if (sessionId) {
      const record = this.memory.get(sessionId);
      if (record && record.userId === userId) return this.toSession(record);
    }
    return this.createMemorySession(userId);
  }

  async save(session: TripAssistantSession, userId: number): Promise<TripAssistantSession> {
    const record: SessionRecord = {
      id: session.session_id,
      userId,
      state: {
        messages: session.messages,
        draft: session.draft,
      },
      createdTripId: session.created_trip_id ?? null,
      createdTrip: session.created_trip ?? null,
    };

    if (this.useNeon) {
      const sql = this.sql();
      await sql`
        insert into trip_assistant_sessions (id, user_id, state_json, created_trip_id, created_trip_json, updated_at)
        values (${record.id}, ${record.userId}, ${JSON.stringify(record.state)}, ${record.createdTripId}, ${record.createdTrip ? JSON.stringify(record.createdTrip) : null}, now())
        on conflict (id)
        do update set
          user_id = excluded.user_id,
          state_json = excluded.state_json,
          created_trip_id = excluded.created_trip_id,
          created_trip_json = excluded.created_trip_json,
          updated_at = now()
      `;
      return session;
    }

    this.memory.set(record.id, record);
    return session;
  }

  private async ensureSchema(): Promise<void> {
    const sql = this.sql();
    await sql`
      create table if not exists trip_assistant_sessions (
        id text primary key,
        user_id integer not null,
        state_json text not null,
        created_trip_id integer null,
        created_trip_json text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await sql`create index if not exists trip_assistant_sessions_user_updated_idx on trip_assistant_sessions (user_id, updated_at desc)`;
  }

  private sql(): Sql {
    if (!this.client) {
      const connectionString = (process.env.AI_NEON_DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim() || '').trim();
      if (!connectionString) {
        throw new Error('AI_NEON_DATABASE_URL is not configured');
      }
      this.client = postgres(connectionString, {
        ssl: 'require',
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
      });
    }
    return this.client;
  }

  private parseState(raw: string | null | undefined): AssistantState {
    try {
      const parsed = JSON.parse(raw || '{}') as Partial<AssistantState>;
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages.filter(Boolean) as TripAssistantMessage[] : [],
        draft: parsed.draft && typeof parsed.draft === 'object' ? parsed.draft as TripAssistantDraft : {},
      };
    } catch {
      return { messages: [], draft: {} };
    }
  }

  private toSession(record: SessionRecord): TripAssistantSession {
    return {
      session_id: record.id,
      messages: record.state.messages,
      draft: record.state.draft,
      created_trip_id: record.createdTripId ?? null,
      created_trip: record.createdTrip ? record.createdTrip : null,
    };
  }

  private async getNeonSession(sessionId: string, userId: number): Promise<TripAssistantSession | null> {
    const sql = this.sql();
    const rows = await sql<{
      id: string;
      user_id: number;
      state_json: string;
      created_trip_id: number | null;
      created_trip_json: string | null;
    }[]>`
      select id, user_id, state_json, created_trip_id, created_trip_json
      from trip_assistant_sessions
      where id = ${sessionId} and user_id = ${userId}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const state = this.parseState(row.state_json);
    return {
      session_id: row.id,
      messages: state.messages,
      draft: state.draft,
      created_trip_id: row.created_trip_id ?? null,
      created_trip: row.created_trip_json ? JSON.parse(row.created_trip_json) as Trip : null,
    };
  }

  private async createNeonSession(userId: number): Promise<TripAssistantSession> {
    const sessionId = crypto.randomUUID();
    const session: TripAssistantSession = { session_id: sessionId, messages: [], draft: {}, created_trip_id: null, created_trip: null };
    await this.save(session, userId);
    return session;
  }

  private async createMemorySession(userId: number): Promise<TripAssistantSession> {
    const sessionId = crypto.randomUUID();
    const record: SessionRecord = { id: sessionId, userId, state: { messages: [], draft: {} }, createdTripId: null, createdTrip: null };
    this.memory.set(sessionId, record);
    return this.toSession(record);
  }
}