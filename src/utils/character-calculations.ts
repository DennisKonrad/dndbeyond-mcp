/**
 * Shared character calculation utilities used by both tools and resources.
 * These are the canonical implementations for ability scores, AC, HP, and level.
 */

import type {
  DdbCharacter,
  DdbAbilityScore,
  DdbModifier,
} from "../types/character.js";

export const ABILITY_NAMES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

// Maps stat ID (1-6) to the subType prefix used in D&D Beyond modifiers
export const ABILITY_SUBTYPE_MAP: Record<number, string> = {
  1: "strength-score",
  2: "dexterity-score",
  3: "constitution-score",
  4: "intelligence-score",
  5: "wisdom-score",
  6: "charisma-score",
};

export function calculateAbilityModifier(score: number): string {
  const modifier = Math.floor((score - 10) / 2);
  return modifier >= 0 ? `+${modifier}` : `${modifier}`;
}

export function sumModifierBonuses(
  modifiers: Record<string, DdbModifier[]>,
  subType: string
): number {
  let total = 0;
  for (const list of Object.values(modifiers)) {
    if (!Array.isArray(list)) continue;
    for (const mod of list) {
      if (mod.type === "bonus" && mod.subType === subType && mod.value != null) {
        total += mod.value;
      }
    }
  }
  return total;
}

// True if any modifier group carries an ability *-score bonus.
function groupHasAbilityScoreBonus(list: DdbModifier[] | undefined): boolean {
  return (
    Array.isArray(list) &&
    list.some((m) => m.type === "bonus" && /-score$/.test(m.subType ?? "") && m.value != null)
  );
}

// Sums ability *-score bonuses, replicating D&D Beyond's observed behavior:
// under the 2024 rules ability boosts come from the background/feat, and a
// character that has any feat/background ability-score bonus has its legacy
// SPECIES (race-group) ability boosts suppressed entirely. Characters with only
// racial boosts (no feat/background ASI) keep them.
// (Empirically verified against live sheets: Varis/Kaplan drop race, Krakzinn keeps it.)
function sumAbilityScoreBonus(
  modifiers: Record<string, DdbModifier[]>,
  subType: string
): number {
  const suppressRace =
    groupHasAbilityScoreBonus(modifiers.feat) || groupHasAbilityScoreBonus(modifiers.background);

  let total = 0;
  for (const [group, list] of Object.entries(modifiers)) {
    if (!Array.isArray(list)) continue;
    if (suppressRace && group === "race") continue;
    for (const mod of list) {
      if (mod.type === "bonus" && mod.subType === subType && mod.value != null) {
        total += mod.value;
      }
    }
  }
  return total;
}

export function computeFinalAbilityScore(
  base: DdbAbilityScore[],
  bonus: DdbAbilityScore[],
  override: DdbAbilityScore[],
  modifiers: Record<string, DdbModifier[]>,
  id: number
): number {
  const overrideValue = override.find((s) => s.id === id)?.value;
  if (overrideValue !== null && overrideValue !== undefined) return overrideValue;

  const baseValue = base.find((s) => s.id === id)?.value ?? 10;
  const bonusValue = bonus.find((s) => s.id === id)?.value ?? 0;
  const modifierBonus = sumAbilityScoreBonus(modifiers, ABILITY_SUBTYPE_MAP[id] ?? "");
  return baseValue + bonusValue + modifierBonus;
}

export function computeLevel(char: DdbCharacter): number {
  return char.classes.reduce((sum, cls) => sum + cls.level, 0);
}

export function calculateMaxHp(char: DdbCharacter): number {
  // An explicit override is the absolute total — ignore everything else.
  if (char.overrideHitPoints != null) return char.overrideHitPoints;

  // D&D Beyond's baseHitPoints is the sum of hit dice only; the Constitution
  // contribution (and any hit-points-per-level bonus such as the Tough feat or
  // Hill Dwarf toughness) is applied per level on top of it.
  const base = char.baseHitPoints;
  const bonus = char.bonusHitPoints ?? 0;
  const level = computeLevel(char);
  const conScore = computeFinalAbilityScore(
    char.stats,
    char.bonusStats,
    char.overrideStats,
    char.modifiers,
    3
  );
  const conMod = Math.floor((conScore - 10) / 2);
  const hpPerLevelBonus = sumModifierBonuses(char.modifiers, "hit-points-per-level");
  return base + bonus + (conMod + hpPerLevelBonus) * level;
}

export function calculateCurrentHp(char: DdbCharacter): number {
  const max = calculateMaxHp(char);
  return max - char.removedHitPoints;
}

export function calculateAc(char: DdbCharacter): number {
  const dexMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 2) - 10) / 2);
  const conMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 3) - 10) / 2);
  const wisMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 5) - 10) / 2);

  // Find equipped armor and shields
  let baseAc = 10;
  let armorType: "heavy" | "medium" | "light" | "none" = "none";
  let shieldBonus = 0;

  for (const item of char.inventory) {
    if (!item.equipped) continue;

    const itemType = item.definition.type?.toLowerCase() || "";
    const filterType = item.definition.filterType?.toLowerCase() || "";
    // Body armor has an empty `type` on D&D Beyond; the armor/shield class lives
    // in `armorTypeId` (1=light, 2=medium, 3=heavy, 4=shield) with filterType "Armor".
    const armorTypeId = item.definition.armorTypeId;

    const isArmorItem = filterType === "armor" || itemType.includes("armor") || itemType.includes("shield");
    if (!isArmorItem) continue;

    // Check for shield
    if (armorTypeId === 4 || itemType.includes("shield")) {
      shieldBonus = item.definition.armorClass ?? 2;
      continue;
    }

    // Body armor — classify by armorTypeId, falling back to the type/filterType strings
    const acValue = item.definition.armorClass ?? 10;
    baseAc = acValue;
    if (armorTypeId === 3 || filterType.includes("heavy") || itemType.includes("heavy")) {
      armorType = "heavy";
    } else if (armorTypeId === 2 || filterType.includes("medium") || itemType.includes("medium")) {
      armorType = "medium";
    } else {
      // armorTypeId === 1 or unclear → treat as light
      armorType = "light";
    }
  }

  // Apply DEX modifier based on armor type
  let finalAc = baseAc;
  if (armorType === "none") {
    // Check for unarmored defense
    const isBarbarian = char.classes.some(cls => cls.definition.name === "Barbarian");
    const isMonk = char.classes.some(cls => cls.definition.name === "Monk");

    if (isBarbarian) {
      finalAc = 10 + dexMod + conMod;
    } else if (isMonk) {
      finalAc = 10 + dexMod + wisMod;
    } else {
      finalAc = 10 + dexMod;
    }
  } else if (armorType === "light") {
    finalAc = baseAc + dexMod;
  } else if (armorType === "medium") {
    finalAc = baseAc + Math.min(dexMod, 2);
  } else if (armorType === "heavy") {
    finalAc = baseAc; // No DEX bonus
  }

  // Add shield bonus
  finalAc += shieldBonus;

  // Add AC modifiers from features/spells
  const acBonus = sumModifierBonuses(char.modifiers, "armor-class")
    + sumModifierBonuses(char.modifiers, "armored-armor-class")
    + sumModifierBonuses(char.modifiers, "unarmored-armor-class");

  finalAc += acBonus;

  return finalAc;
}
