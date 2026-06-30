import { describe, it, expect } from "vitest";
import { resolveModifier } from "../../src/tools/homebrew.js";

describe("resolveModifier", () => {
  it("maps a +1 initiative bonus to the right type/subtype ids", () => {
    const { fields, label } = resolveModifier({ type: "bonus", subType: "initiative", value: 1 });
    expect(fields.typeId).toBe(1); // Bonus
    expect(fields.subTypeId).toBe(218); // Initiative (bonus group)
    expect(fields.fixedValue).toBe(1);
    expect(label).toBe("Bonus Initiative +1");
  });

  it("picks the subtype belonging to the chosen type group", () => {
    // 'initiative' exists under several type groups; advantage must resolve to its own.
    const { fields } = resolveModifier({ type: "advantage", subType: "initiative" });
    expect(fields.typeId).toBe(3); // Advantage
    expect(fields.subTypeId).toBe(217); // Initiative (advantage group)
    expect(fields.fixedValue).toBeUndefined();
  });

  it("parses dice expressions", () => {
    const { fields, label } = resolveModifier({ type: "bonus", subType: "hit points", dice: "2d8" });
    expect(fields.diceCount).toBe(2);
    expect(fields.diceValue).toBe(8);
    expect(label).toContain("2d8");
  });

  it("resolves a resistance damage type", () => {
    const { fields } = resolveModifier({ type: "resistance", subType: "fire" });
    expect(fields.typeId).toBe(5); // Resistance
    expect(fields.subTypeId).toBe(134); // Fire (resistance group)
  });

  it("throws a helpful error on an unknown type", () => {
    expect(() => resolveModifier({ type: "sparkle" })).toThrow(/Unknown modifier type/);
  });

  it("throws a helpful error on an unknown subtype", () => {
    expect(() => resolveModifier({ type: "bonus", subType: "not-a-stat" })).toThrow(
      /Unknown modifier subtype/,
    );
  });
});
