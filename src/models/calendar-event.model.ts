import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * Calendar events synced from the user's primary Google Calendar (a rolling window around today).
 * Recurring events are stored as individual instances. The worker repo keeps an identical copy.
 */
const personSchema = new Schema(
  {
    email: { type: String },
    name: { type: String },
    responseStatus: { type: String },
    self: { type: Boolean },
    organizer: { type: Boolean },
  },
  { _id: false },
);

const calendarEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    googleEventId: { type: String, required: true },
    recurringEventId: { type: String },
    summary: { type: String, default: '' },
    description: { type: String },
    location: { type: String },
    /** Timed events: exact instants. All-day events: UTC midnight of startDate/endDate. */
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    allDay: { type: Boolean, default: false },
    /** All-day events only: "YYYY-MM-DD", end exclusive (as Google returns them). */
    startDate: { type: String },
    endDate: { type: String },
    timeZone: { type: String },
    status: { type: String, default: 'confirmed' },
    /** `transparent` = shown as free. */
    transparency: { type: String, default: 'opaque' },
    eventType: { type: String, default: 'default' },
    /** The user's own RSVP: accepted / tentative / declined / needsAction. */
    myResponseStatus: { type: String },
    organizer: { type: personSchema },
    attendees: { type: [personSchema], default: [] },
    meetLink: { type: String },
    htmlLink: { type: String },
    googleUpdatedAt: { type: Date },
    /** Set by each worker sync; events in the window without the latest id were deleted. */
    syncRunId: { type: String },
  },
  { timestamps: true },
);

calendarEventSchema.index({ userId: 1, googleEventId: 1 }, { unique: true });
calendarEventSchema.index({ userId: 1, start: 1 });

export type CalendarEvent = InferSchemaType<typeof calendarEventSchema>;
export type CalendarEventDocument = HydratedDocument<CalendarEvent>;

export const CalendarEventModel = model('CalendarEvent', calendarEventSchema);
