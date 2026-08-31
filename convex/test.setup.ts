import { convexTest } from "convex-test"

import schema from "./schema"

/**
 * convex-test needs an explicit module map — Vite's glob is resolved at build
 * time. See https://docs.convex.dev/testing/convex-test.
 */
export const modules = import.meta.glob("./**/*.ts")

export const CLERK_ID = "user_test_founder"
export const OTHER_CLERK_ID = "user_test_stranger"

/** A fresh in-memory deployment loaded with the Core schema. */
export const setupTest = () => convexTest(schema, modules)
