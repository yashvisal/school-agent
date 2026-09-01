/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as changes from "../changes.js";
import type * as courses from "../courses.js";
import type * as crons from "../crons.js";
import type * as deadlines from "../deadlines.js";
import type * as dev_fixtures from "../dev/fixtures.js";
import type * as dev_seed from "../dev/seed.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as ingest_canvas from "../ingest/canvas.js";
import type * as ingest_extracted from "../ingest/extracted.js";
import type * as ingest_ical from "../ingest/ical.js";
import type * as ingest_pollAll from "../ingest/pollAll.js";
import type * as ingest_schedule from "../ingest/schedule.js";
import type * as ingest_site from "../ingest/site.js";
import type * as ingest_snapshots from "../ingest/snapshots.js";
import type * as ingest_sources from "../ingest/sources.js";
import type * as ingest_syllabus from "../ingest/syllabus.js";
import type * as ingest_uploads from "../ingest/uploads.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_canvas_client from "../lib/canvas/client.js";
import type * as lib_canvas_linkHeader from "../lib/canvas/linkHeader.js";
import type * as lib_canvas_normalize from "../lib/canvas/normalize.js";
import type * as lib_canvas_types from "../lib/canvas/types.js";
import type * as lib_changes from "../lib/changes.js";
import type * as lib_diff from "../lib/diff.js";
import type * as lib_effortPriors from "../lib/effortPriors.js";
import type * as lib_extraction_anydoc from "../lib/extraction/anydoc.js";
import type * as lib_extraction_llm from "../lib/extraction/llm.js";
import type * as lib_extraction_normalize from "../lib/extraction/normalize.js";
import type * as lib_extraction_prompts from "../lib/extraction/prompts.js";
import type * as lib_extraction_run from "../lib/extraction/run.js";
import type * as lib_extraction_schemas from "../lib/extraction/schemas.js";
import type * as lib_extraction_siteLinks from "../lib/extraction/siteLinks.js";
import type * as lib_httpAuth from "../lib/httpAuth.js";
import type * as lib_ical_parse from "../lib/ical/parse.js";
import type * as lib_ingest from "../lib/ingest.js";
import type * as lib_merge from "../lib/merge.js";
import type * as lib_net from "../lib/net.js";
import type * as lib_normalized from "../lib/normalized.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_planner from "../lib/planner.js";
import type * as lib_signals from "../lib/signals.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_validators from "../lib/validators.js";
import type * as nightly from "../nightly.js";
import type * as onboarding from "../onboarding.js";
import type * as planner from "../planner.js";
import type * as signals from "../signals.js";
import type * as students from "../students.js";
import type * as tasks from "../tasks.js";
import type * as usage from "../usage.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  changes: typeof changes;
  courses: typeof courses;
  crons: typeof crons;
  deadlines: typeof deadlines;
  "dev/fixtures": typeof dev_fixtures;
  "dev/seed": typeof dev_seed;
  http: typeof http;
  inbound: typeof inbound;
  "ingest/canvas": typeof ingest_canvas;
  "ingest/extracted": typeof ingest_extracted;
  "ingest/ical": typeof ingest_ical;
  "ingest/pollAll": typeof ingest_pollAll;
  "ingest/schedule": typeof ingest_schedule;
  "ingest/site": typeof ingest_site;
  "ingest/snapshots": typeof ingest_snapshots;
  "ingest/sources": typeof ingest_sources;
  "ingest/syllabus": typeof ingest_syllabus;
  "ingest/uploads": typeof ingest_uploads;
  "lib/auth": typeof lib_auth;
  "lib/canvas/client": typeof lib_canvas_client;
  "lib/canvas/linkHeader": typeof lib_canvas_linkHeader;
  "lib/canvas/normalize": typeof lib_canvas_normalize;
  "lib/canvas/types": typeof lib_canvas_types;
  "lib/changes": typeof lib_changes;
  "lib/diff": typeof lib_diff;
  "lib/effortPriors": typeof lib_effortPriors;
  "lib/extraction/anydoc": typeof lib_extraction_anydoc;
  "lib/extraction/llm": typeof lib_extraction_llm;
  "lib/extraction/normalize": typeof lib_extraction_normalize;
  "lib/extraction/prompts": typeof lib_extraction_prompts;
  "lib/extraction/run": typeof lib_extraction_run;
  "lib/extraction/schemas": typeof lib_extraction_schemas;
  "lib/extraction/siteLinks": typeof lib_extraction_siteLinks;
  "lib/httpAuth": typeof lib_httpAuth;
  "lib/ical/parse": typeof lib_ical_parse;
  "lib/ingest": typeof lib_ingest;
  "lib/merge": typeof lib_merge;
  "lib/net": typeof lib_net;
  "lib/normalized": typeof lib_normalized;
  "lib/phone": typeof lib_phone;
  "lib/planner": typeof lib_planner;
  "lib/signals": typeof lib_signals;
  "lib/time": typeof lib_time;
  "lib/validators": typeof lib_validators;
  nightly: typeof nightly;
  onboarding: typeof onboarding;
  planner: typeof planner;
  signals: typeof signals;
  students: typeof students;
  tasks: typeof tasks;
  usage: typeof usage;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
