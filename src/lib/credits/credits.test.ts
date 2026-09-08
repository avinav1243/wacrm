import { describe, expect, it } from "vitest";

import {
  MESSAGE_CREDIT_CATEGORIES,
  isCreditCategory,
} from "./credits";

describe("isCreditCategory", () => {
  it("accepts the three template categories", () => {
    expect(isCreditCategory("Marketing")).toBe(true);
    expect(isCreditCategory("Utility")).toBe(true);
    expect(isCreditCategory("Authentication")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCreditCategory("marketing")).toBe(false); // case-sensitive
    expect(isCreditCategory("Promo")).toBe(false);
    expect(isCreditCategory("")).toBe(false);
    expect(isCreditCategory(null)).toBe(false);
    expect(isCreditCategory(undefined)).toBe(false);
  });
});

describe("MESSAGE_CREDIT_CATEGORIES", () => {
  it("lists exactly the three categories the guard accepts", () => {
    expect(MESSAGE_CREDIT_CATEGORIES).toEqual([
      "Marketing",
      "Utility",
      "Authentication",
    ]);
    for (const category of MESSAGE_CREDIT_CATEGORIES) {
      expect(isCreditCategory(category)).toBe(true);
    }
  });
});
