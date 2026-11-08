const { Double } = require("mongodb");
const { Schema } = require("mongoose");
const { customFieldDefinitionSchema } = require("./customFieldDefinition");
const { mediaReferenceSchema } = require("./mediaSchema");
const { reviewField } = require("./reviewSchema");
const {
  VALIDITY_MODES,
  USAGE_MODES,
  CAPACITY_CHECKS,
} = require("../entities/admission/admission-definition");

const priceCategorySchemaDefinition = {
  priceEur: { type: Number, required: true },
  interval: {
    type: Object,
    default: { start: null, end: null },
  },
  fixedPrice: { type: Boolean, default: false },
  holidays: { type: [Object], default: [] },
  weekdays: { type: [Number], default: [] },
};

const attachmentSchemaDefinition = {
  id: { type: String, required: true },
  title: { type: String, required: true },
  caption: { type: String, default: "" },
  type: { type: String, required: true },
  // The file of an attachment is a media reference; the context fields around
  // it stay here, at the usage site. `url` is the legacy raw address the media
  // import (B7) converts — it is read as an external reference until then.
  reference: { type: mediaReferenceSchema, default: undefined },
  url: { type: String, default: "" },
  show: { type: Boolean, default: false },
  required: { type: Boolean, default: false },
  mailAttach: { type: Boolean, default: false },
};

const customFieldValueSchema = new Schema(
  {
    fieldId: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const blockPeriodSchemaDefinition = {
  id: { type: String, required: true },
  label: { type: String, required: true },
  startWeekday: {
    type: Number,
    required: true,
    min: 0,
    max: 6,
    validate: {
      validator: Number.isInteger,
      message: "startWeekday must be an integer",
    },
  },
  startTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  },
  endWeekday: {
    type: Number,
    required: true,
    min: 0,
    max: 6,
    validate: {
      validator: Number.isInteger,
      message: "endWeekday must be an integer",
    },
  },
  endTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  },
};

const serviceHoursSchemaDefinition = {
  weekdays: {
    type: [Number],
    required: true,
    validate: {
      validator: (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (weekday) =>
            Number.isInteger(weekday) && weekday >= 0 && weekday <= 6,
        ),
      message: "weekdays must contain integers between 0 and 6",
    },
  },
  startTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  },
  endTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  },
};

// The admission definition of a ticket (German "Berechtigungsdefinition",
// `entities/admission/admission-definition.js`): copied into every admission
// the ticket issues, so a later change of the tariff changes none of them.
const admissionDefinitionSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    validity: {
      type: new Schema(
        {
          mode: {
            type: String,
            enum: Object.values(VALIDITY_MODES),
            default: VALIDITY_MODES.BOOKING,
          },
          from: { type: String, default: null },
          to: { type: String, default: null },
          days: { type: Number, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    usage: {
      type: new Schema(
        {
          mode: {
            type: String,
            enum: Object.values(USAGE_MODES),
            default: USAGE_MODES.SINGLE,
          },
          quota: { type: Number, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    blockMinutes: { type: Number, default: 0, min: 0 },
    personalized: { type: Boolean, default: false },
    admissionsPerUnit: { type: Number, default: 1, min: 1 },
    capacityCheck: {
      type: String,
      enum: Object.values(CAPACITY_CHECKS),
      default: CAPACITY_CHECKS.BOOKING,
    },
  },
  { _id: false },
);

// The settings of a facility whose tickets are checked at its entrance.
const admissionFacilitySchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    resetTime: { type: String, default: "03:00" },
    exitScan: { type: Boolean, default: true },
    maxStayMinutes: { type: Number, default: null },
    timezone: { type: String, default: "Europe/Berlin" },
    // When the schedule of the daily reset last changed (epoch ms), set on
    // the write (`stampFacilitySchedule`), never taken from a client.
    scheduleChangedAt: { type: Number, default: null },
  },
  { _id: false },
);

const bookableSchemaDefinition = {
  id: { type: String, required: true, unique: true },
  tenantId: { type: String, required: true, ref: "Tenant" },

  // Basic properties
  type: { type: String, enum: ["room", "location", "resource", "ticket"] },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  isPublic: { type: Boolean, default: false },
  // The review of the offer (glossary "Prüfstatus"): the review service's
  // alone, never taken from a store or update body.
  review: reviewField,
  // The ordered image list. Position 0 is the cover image — there is no field
  // of its own for it, reordering the list changes the cover.
  images: { type: [mediaReferenceSchema], default: [] },
  // Legacy single image, kept readable until the media import (B7) has moved
  // it into `images`. It is the fallback of the derived `imgUrl` export field,
  // never written by the application.
  imgUrl: { type: String, default: "" },
  flags: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  location: {
    type: Object,
    default: {
      coordinates: {
        type: "Point",
        points: [null, null],
      },
      display_address: "",
      address: {
        street: null,
        house_number: null,
        postcode: null,
        city: null,
        suburb: null,
        state: null,
        country: null,
        country_code: null,
      },
      meta: {},
    },
  },

  // Booking properties
  isBookable: { type: Boolean, default: false },
  amount: { type: Number, default: null },
  // Units of this bookable one booking may hold at most; null is unlimited.
  maxAmountPerBooking: {
    type: Number,
    default: null,
    min: 1,
    validate: (value) =>
      value === undefined ||
      value === null ||
      value === "" ||
      Number.isInteger(Number(value)),
  },
  minBookingDuration: { type: Number, default: null },
  maxBookingDuration: { type: Number, default: null },
  autoCommitBooking: { type: Boolean, default: false },
  bookingNotes: { type: String, default: "" },
  groupBooking: {
    type: Object,
    default: { enabled: false, permittedRoles: [] },
  },

  // Schedule properties
  isScheduleRelated: { type: Boolean, default: false },
  isTimePeriodRelated: { type: Boolean, default: false },
  timePeriods: { type: [Object], default: [] },
  isOpeningHoursRelated: { type: Boolean, default: false },
  openingHours: { type: [Object], default: [] },
  preparationLeadTimeMinutes: { type: Number, default: null, min: 0 },
  serviceHours: {
    type: [new Schema(serviceHoursSchemaDefinition, { _id: false })],
    default: [],
  },
  bufferTimeBeforeMinutes: { type: Number, default: null, min: 0 },
  bufferTimeAfterMinutes: { type: Number, default: null, min: 0 },
  isSpecialOpeningHoursRelated: { type: Boolean, default: false },
  specialOpeningHours: { type: [Object], default: [] },
  isLongRange: { type: Boolean, default: false },
  longRangeOptions: { type: Object, default: null },
  isBlockPeriodRelated: { type: Boolean, default: false },
  blockPeriods: {
    type: [new Schema(blockPeriodSchemaDefinition, { _id: false })],
    default: [],
  },

  // Price properties
  priceCategories: {
    type: [new Schema(priceCategorySchemaDefinition, { _id: false })],
    default: [
      {
        priceEur: 0,
        interval: { start: null, end: null },
        fixedPrice: false,
        holidays: [],
        weekdays: [],
      },
    ],
  },
  priceType: {
    type: String,
    enum: ["per-hour", "per-day", "per-item", "per-square-meter"],
    default: "per-item",
  },
  priceValueAddedTax: { type: Number, default: 0 },
  enableCoupons: { type: Boolean, default: true },

  // Permission properties
  requiresLogin: { type: Boolean, default: false },
  permittedUsers: { type: [String], default: [] },
  permittedRoles: { type: [String], default: [] },
  bookingDiscounts: {
    type: new Schema(
      {
        users: {
          type: [
            new Schema(
              {
                userId: { type: String, required: true },
                discountPercent: {
                  type: Number,
                  default: 0,
                  min: 0,
                  max: 100,
                  validate: {
                    validator: Number.isInteger,
                    message: "discountPercent must be an integer",
                  },
                },
              },
              { _id: false },
            ),
          ],
          default: [],
        },
        roles: {
          type: [
            new Schema(
              {
                roleId: { type: String, required: true },
                discountPercent: {
                  type: Number,
                  default: 0,
                  min: 0,
                  max: 100,
                  validate: {
                    validator: Number.isInteger,
                    message: "discountPercent must be an integer",
                  },
                },
              },
              { _id: false },
            ),
          ],
          default: [],
        },
      },
      { _id: false },
    ),
    default: { users: [], roles: [] },
  },

  // Cancellation policy
  cancellationPolicy: {
    type: Object,
    default: { userCancellable: true, contactHint: "" },
  },

  // Relationship properties
  relatedBookableIds: { type: [String], default: [] },
  checkoutBookableIds: { type: [Object], default: [] },
  eventId: { type: String, default: "" },
  ownerUserId: { type: String, default: "" },

  // Additional properties
  attachments: {
    type: [new Schema(attachmentSchemaDefinition, { _id: false })],
    default: [],
  },
  // The default is made per bookable - `SchemaUtils.createDefaults` hands a
  // plain default out by reference, and the details are written into while
  // a bookable is stored.
  accessPointDetails: {
    type: Object,
    default: () => ({
      active: false,
      accessBuffer: { before: 0, after: 0 },
      accessPointIds: [],
    }),
  },
  requiredFields: { type: [String], default: ["address", "zipCode", "city"] },

  // Admission (German "Zugangsberechtigung"): the definition a ticket
  // issues its admissions from, and the settings of a facility its tickets
  // are checked at. Both stay unset on every other bookable.
  admission: { type: admissionDefinitionSchema, default: undefined },
  admissionFacility: { type: admissionFacilitySchema, default: undefined },

  externalProviders: {
    type: [
      new Schema(
        {
          active: { type: Boolean, default: false },
          provider: { type: String, required: true },
          handles: {
            type: [String],
            enum: ["pricing", "availability", "maxAmount"],
            default: [],
          },
          config: { type: Object, default: {} },
        },
        { _id: false },
      ),
    ],
    default: [],
  },

  customFieldDefinitions: {
    type: [customFieldDefinitionSchema],
    default: [],
  },

  customFieldValues: {
    type: [customFieldValueSchema],
    default: [],
  },

  // Timestamps
  timeCreated: { type: Double, default: () => Date.now() },
  timeUpdated: { type: Double, default: () => Date.now() },
};

module.exports = {
  bookableSchemaDefinition,
  blockPeriodSchemaDefinition,
  serviceHoursSchemaDefinition,
};
