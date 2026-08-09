import { z } from 'zod';
import { tripSchema } from '../trip/trip.schema';

export const tripAssistantMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  created_at: z.string().optional(),
});
export type TripAssistantMessage = z.infer<typeof tripAssistantMessageSchema>;

export const tripAssistantDraftSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  reminder_days: z.number().nullable().optional(),
  day_count: z.number().nullable().optional(),
  destination: z.string().nullable().optional(),
  travelers: z.number().nullable().optional(),
  budget: z.number().nullable().optional(),
  style: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type TripAssistantDraft = z.infer<typeof tripAssistantDraftSchema>;

export const tripAssistantRequestSchema = z.object({
  session_id: z.string().optional(),
  message: z.string().min(1),
  locale: z.string().optional(),
  timezone: z.string().optional(),
});
export type TripAssistantRequest = z.infer<typeof tripAssistantRequestSchema>;

export const tripAssistantSessionSchema = z.object({
  session_id: z.string().min(1),
  messages: z.array(tripAssistantMessageSchema),
  draft: tripAssistantDraftSchema,
  created_trip_id: z.number().nullable().optional(),
  created_trip: tripSchema.nullable().optional(),
});
export type TripAssistantSession = z.infer<typeof tripAssistantSessionSchema>;

export const tripAssistantResponseSchema = tripAssistantSessionSchema.extend({
  assistant_message: z.string().min(1),
  ready_to_create: z.boolean(),
  missing_fields: z.array(z.string()),
});
export type TripAssistantResponse = z.infer<typeof tripAssistantResponseSchema>;