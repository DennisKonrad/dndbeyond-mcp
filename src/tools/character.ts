import { createHash } from "node:crypto";
import type { DdbClient } from "../api/client.js";
import { ENDPOINTS } from "../api/endpoints.js";
import { getUserId } from "../api/auth.js";
import { HttpError } from "../resilience/index.js";
import type {
  DdbCharacter,
  DdbAction,
  DdbModifier,
  DdbSpell,
  DdbFeat,
  DdbClassFeature,
  DdbRacialTrait,
  DdbInventoryItem,
} from "../types/character.js";
import type { DdbCampaign, DdbCampaignCharacter2, DdbPartyInventory } from "../types/api.js";
import { fuzzyMatch, levenshteinDistance } from "../utils/fuzzy-match.js";
import { ABILITY_NAMES, ABILITY_SUBTYPE_MAP, calculateAbilityModifier, sumModifierBonuses, computeFinalAbilityScore, computeLevel, calculateMaxHp, calculateCurrentHp, calculateAc } from "../utils/character-calculations.js";

interface GetCharacterParams {
  characterId?: number;
  characterName?: string;
  detail?: "summary" | "sheet" | "full";
  forceRefresh?: boolean;
}

/**
 * Reliable "did the combat state change" token over the volatile fields —
 * including removedHitPoints, so it flips on gameplay HP changes. Deliberately
 * EXCLUDES dateModified: DDB advances that stamp on its own (sheet touches)
 * without HP changing (verified 2026-06-28), which would make the fingerprint
 * a false positive for HP. dateModified does NOT track combat-tracker HP, so
 * this fingerprint — not dateModified — is the trustworthy HP change check.
 */
export function fingerprintCharacter(char: DdbCharacter): string {
  const sig = JSON.stringify({
    rm: char.removedHitPoints,
    tmp: char.temporaryHitPoints,
    ovr: char.overrideHitPoints,
    base: char.baseHitPoints,
    bonus: char.bonusHitPoints,
    death: char.deathSaves,
    slots: char.spellSlots,
    pact: char.pactMagic,
  });
  return createHash("sha256").update(sig).digest("hex").slice(0, 10);
}

/**
 * One-line freshness footer. `fp` is the reliable change token (same fp across
 * two reads = unchanged, incl. HP). `dateModified` is only the last sheet edit
 * (does NOT capture combat HP). fromCache/age tells you whether the shown copy
 * might already be behind DDB — forceRefresh to guarantee current.
 */
function formatFreshness(char: DdbCharacter, fromCache: boolean, ageMs: number): string {
  const dm = char.dateModified;
  const edited = dm ? `${dm.slice(0, 19).replace("T", " ")}Z` : "?";
  const source = fromCache
    ? `Cache, ${Math.round(ageMs / 1000)}s alt · forceRefresh=true für frisch`
    : "live (gerade geladen)";
  return `\n— Stand: fp:${fingerprintCharacter(char)} · ${source} · letzter Sheet-Edit ${edited}`;
}

interface GetDefinitionParams {
  characterId?: number;
  characterName?: string;
  name: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function formatAbilityScores(char: DdbCharacter): string {
  return ABILITY_NAMES.map((name, idx) => {
    const id = idx + 1;
    const score = computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, id);
    const modifier = calculateAbilityModifier(score);
    return `${name}: ${score} (${modifier})`;
  }).join(" | ");
}

function formatClasses(char: DdbCharacter): string {
  const classes = char.classes
    .sort((a, b) => (b.isStartingClass ? 1 : 0) - (a.isStartingClass ? 1 : 0))
    .map((cls) => {
      const subclass = cls.subclassDefinition?.name ? ` (${cls.subclassDefinition.name})` : "";
      return `${cls.definition.name}${subclass} ${cls.level}`;
    });
  return classes.join(" / ");
}

function formatHp(char: DdbCharacter): string {
  const current = calculateCurrentHp(char);
  const max = calculateMaxHp(char);
  const temp = char.temporaryHitPoints;
  return temp > 0 ? `${current}/${max} (+${temp} temp)` : `${current}/${max}`;
}

const SPELL_ABILITY_ABBR: Record<number, string> = { 1: "STR", 2: "DEX", 3: "CON", 4: "INT", 5: "WIS", 6: "CHA" };
// D&D Beyond limitedUse.resetType convention
const LIMITED_USE_RESET: Record<number, string> = { 1: "short rest", 2: "long rest", 3: "day", 4: "recharge" };

// Resolve which feat/feature/item granted a spell, from its componentId.
// Falls back to the container category (class/feat/item/species/background).
function resolveSpellSource(spell: DdbSpell, category: string, char: DdbCharacter): string {
  const cid = spell.componentId;
  if (cid != null) {
    const feat = (char.feats ?? []).find((f) => f.definition?.id === cid);
    if (feat?.definition?.name) return `feat: ${feat.definition.name}`;
    const item = (char.inventory ?? []).find((i) => (i.definition as { id?: number })?.id === cid);
    if (item?.definition?.name) return `item: ${item.definition.name}`;
    for (const cls of char.classes ?? []) {
      const feats = (cls as { classFeatures?: Array<{ id?: number; definition?: { id?: number; name?: string } }> }).classFeatures ?? [];
      const cf = feats.find((f) => f.definition?.id === cid || f.id === cid);
      if (cf?.definition?.name) return `class: ${cf.definition.name}`;
    }
  }
  return category;
}

// Describe HOW a spell is cast: prepared state, limited uses, slot usage, casting ability.
function formatSpellMode(spell: DdbSpell): string {
  const parts: string[] = [];
  if (spell.alwaysPrepared) parts.push("always prepared");
  else if (spell.prepared) parts.push("prepared");
  const lu = spell.limitedUse;
  if (lu && lu.maxUses != null) {
    const reset = lu.resetType != null ? (LIMITED_USE_RESET[lu.resetType] ?? `reset ${lu.resetType}`) : "limited";
    parts.push(`${lu.maxUses}/${reset}`);
  }
  if (spell.usesSpellSlot === false) parts.push("no slot");
  else if (spell.usesSpellSlot === true) parts.push("spell slot");
  const abil = spell.spellCastingAbilityId;
  if (abil && SPELL_ABILITY_ABBR[abil]) parts.push(SPELL_ABILITY_ABBR[abil]);
  return parts.join(" · ");
}

function getAllSpellsWithSource(char: DdbCharacter): Array<{ spell: DdbSpell; category: string }> {
  const out: Array<{ spell: DdbSpell; category: string }> = [];
  const add = (arr: DdbSpell[] | null | undefined, category: string) => {
    for (const s of arr ?? []) out.push({ spell: s, category });
  };
  add(char.spells.class, "class");
  add(char.spells.race, "species");
  add(char.spells.background, "background");
  add(char.spells.item, "item");
  add(char.spells.feat, "feat");
  return out;
}

function formatSpells(char: DdbCharacter): string {
  const prepared = getAllSpellsWithSource(char).filter(
    ({ spell }) => spell.prepared || spell.alwaysPrepared
  );
  if (prepared.length === 0) return StringUtils.EMPTY;

  // Each entry is annotated with its source + casting mode so that two entries
  // with the same name (e.g. a feat granting one spell in two cast modes) stay
  // distinguishable instead of collapsing to "Polymorph, Polymorph".
  const byLevel = prepared.reduce((acc, { spell, category }) => {
    const level = spell.definition.level;
    if (!acc[level]) acc[level] = [];
    const tag = [resolveSpellSource(spell, category, char), formatSpellMode(spell)]
      .filter(Boolean)
      .join(" · ");
    acc[level].push(tag ? `${spell.definition.name} (${tag})` : spell.definition.name);
    return acc;
  }, {} as Record<number, string[]>);

  const lines = Object.entries(byLevel)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, spells]) => {
      const levelLabel = level === "0" ? "Cantrips" : `Level ${level}`;
      return `  ${levelLabel}:\n${spells.map((s) => `    - ${s}`).join("\n")}`;
    });

  return `\nPrepared Spells:\n${lines.join("\n")}`;
}

function formatInventory(char: DdbCharacter): string {
  const inventory = char.inventory ?? [];
  if (inventory.length === 0) return StringUtils.EMPTY;

  // Equipped items first (each marked), then the rest, preserving original order within each group.
  const ordered = [
    ...inventory.filter((item) => item.equipped),
    ...inventory.filter((item) => !item.equipped),
  ];

  const items = ordered.map((item) => {
    const qty = item.quantity > 1 ? ` (x${item.quantity})` : StringUtils.EMPTY;
    const equipped = item.equipped ? " [equipped]" : StringUtils.EMPTY;
    return `  - ${item.definition.name}${qty}${equipped}`;
  });

  return `\nInventory (${inventory.length} items):\n${items.join("\n")}`;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getAllSpells(char: DdbCharacter): DdbSpell[] {
  return [
    ...(char.spells.class ?? []),
    ...(char.spells.race ?? []),
    ...(char.spells.background ?? []),
    ...(char.spells.item ?? []),
    ...(char.spells.feat ?? []),
  ];
}

function stripHtml(s: string | null | undefined): string {
  if (!s) return StringUtils.EMPTY;
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function resolveCharacterId(
  client: DdbClient,
  params: GetCharacterParams
): Promise<number | string> {
  if (params.characterId) return params.characterId;
  if (params.characterName) {
    const foundId = await findCharacterByName(client, params.characterName);
    if (!foundId) return `Character "${params.characterName}" not found.`;
    return foundId;
  }
  return "Either characterId or characterName must be provided.";
}

// Normalizes class/subclass feature access — class features nest under .definition,
// subclass features have flat properties
function featureName(f: DdbClassFeature): string {
  return f.definition?.name ?? f.name ?? "Unknown";
}
function featureLevel(f: DdbClassFeature): number {
  return f.definition?.requiredLevel ?? f.requiredLevel ?? 0;
}
function featureDescription(f: DdbClassFeature): string {
  return f.definition?.description ?? f.description ?? "";
}

function calculateProficiencyBonus(level: number): number {
  return Math.ceil(level / 4) + 1;
}

function getAbilityScoreNumeric(char: DdbCharacter, id: number): number {
  return computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, id);
}

function getAbilityModNumeric(char: DdbCharacter, id: number): number {
  return Math.floor((getAbilityScoreNumeric(char, id) - 10) / 2);
}

// ============================================================================
// CHARACTER SHEET FORMATTING
// ============================================================================

const ABILITY_FULL_NAMES: Record<number, string> = {
  1: "Strength",
  2: "Dexterity",
  3: "Constitution",
  4: "Intelligence",
  5: "Wisdom",
  6: "Charisma",
};

const SAVING_THROW_SUBTYPES: Record<number, string> = {
  1: "strength-saving-throws",
  2: "dexterity-saving-throws",
  3: "constitution-saving-throws",
  4: "intelligence-saving-throws",
  5: "wisdom-saving-throws",
  6: "charisma-saving-throws",
};

const SKILL_DEFINITIONS: Array<{ name: string; abilityId: number; subType: string }> = [
  { name: "Acrobatics", abilityId: 2, subType: "acrobatics" },
  { name: "Animal Handling", abilityId: 5, subType: "animal-handling" },
  { name: "Arcana", abilityId: 4, subType: "arcana" },
  { name: "Athletics", abilityId: 1, subType: "athletics" },
  { name: "Deception", abilityId: 6, subType: "deception" },
  { name: "History", abilityId: 4, subType: "history" },
  { name: "Insight", abilityId: 5, subType: "insight" },
  { name: "Intimidation", abilityId: 6, subType: "intimidation" },
  { name: "Investigation", abilityId: 4, subType: "investigation" },
  { name: "Medicine", abilityId: 5, subType: "medicine" },
  { name: "Nature", abilityId: 4, subType: "nature" },
  { name: "Perception", abilityId: 5, subType: "perception" },
  { name: "Performance", abilityId: 6, subType: "performance" },
  { name: "Persuasion", abilityId: 6, subType: "persuasion" },
  { name: "Religion", abilityId: 4, subType: "religion" },
  { name: "Sleight of Hand", abilityId: 2, subType: "sleight-of-hand" },
  { name: "Stealth", abilityId: 2, subType: "stealth" },
  { name: "Survival", abilityId: 5, subType: "survival" },
];

function hasModifierBySubType(
  modifiers: Record<string, DdbModifier[]>,
  subType: string,
  type: string
): boolean {
  for (const list of Object.values(modifiers)) {
    if (!Array.isArray(list)) continue;
    for (const mod of list) {
      if (mod.subType === subType && mod.type === type) return true;
    }
  }
  return false;
}

function formatSavingThrows(char: DdbCharacter): string {
  const profBonus = calculateProficiencyBonus(computeLevel(char));
  const saves = [];

  for (let id = 1; id <= 6; id++) {
    const mod = getAbilityModNumeric(char, id);
    const proficient = hasModifierBySubType(char.modifiers, SAVING_THROW_SUBTYPES[id], "proficiency");
    const total = mod + (proficient ? profBonus : 0);
    const sign = total >= 0 ? "+" : "";
    const prof = proficient ? " *" : "";
    saves.push(`${ABILITY_NAMES[id - 1]}: ${sign}${total}${prof}`);
  }

  return saves.join(" | ");
}

function formatSkills(char: DdbCharacter): string {
  const profBonus = calculateProficiencyBonus(computeLevel(char));

  const lines = SKILL_DEFINITIONS.map((skill) => {
    const abilityMod = getAbilityModNumeric(char, skill.abilityId);
    const proficient = hasModifierBySubType(char.modifiers, skill.subType, "proficiency");
    const expertise = hasModifierBySubType(char.modifiers, skill.subType, "expertise");

    let total = abilityMod;
    let marker = "";
    if (expertise) {
      total += profBonus * 2;
      marker = " **";
    } else if (proficient) {
      total += profBonus;
      marker = " *";
    }

    const sign = total >= 0 ? "+" : "";
    return `  ${skill.name}: ${sign}${total}${marker}`;
  });

  return lines.join("\n");
}

// Proficiency subTypes that belong to other sections (saving throws, skills)
const EXCLUDED_PROFICIENCY_SUBTYPES = new Set([
  "strength-saving-throws", "dexterity-saving-throws", "constitution-saving-throws",
  "intelligence-saving-throws", "wisdom-saving-throws", "charisma-saving-throws",
  "acrobatics", "animal-handling", "arcana", "athletics", "deception", "history",
  "insight", "intimidation", "investigation", "medicine", "nature", "perception",
  "performance", "persuasion", "religion", "sleight-of-hand", "stealth", "survival",
]);

const ARMOR_SUBTYPES = new Set(["light-armor", "medium-armor", "heavy-armor", "shields"]);
const WEAPON_GROUPS = new Set(["simple-weapons", "martial-weapons"]);

// Known language subTypes (lowercase, hyphenated)
const LANGUAGE_SUBTYPES = new Set([
  "common", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling", "orc",
  "abyssal", "celestial", "draconic", "deep-speech", "infernal", "primordial",
  "sylvan", "undercommon", "thieves-cant", "druidic", "aarakocra", "auran",
  "aquan", "ignan", "terran",
]);

function formatProficiencies(char: DdbCharacter): string {
  const armor: Set<string> = new Set();
  const weapons: Set<string> = new Set();
  const tools: Set<string> = new Set();
  const languages: Set<string> = new Set();

  for (const list of Object.values(char.modifiers)) {
    if (!Array.isArray(list)) continue;
    for (const mod of list) {
      if (mod.type !== "proficiency") continue;
      if (EXCLUDED_PROFICIENCY_SUBTYPES.has(mod.subType)) continue;

      const displayName = mod.friendlySubtypeName || mod.subType.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      if (ARMOR_SUBTYPES.has(mod.subType)) {
        armor.add(displayName);
      } else if (WEAPON_GROUPS.has(mod.subType)) {
        weapons.add(displayName);
      } else if (LANGUAGE_SUBTYPES.has(mod.subType)) {
        languages.add(displayName);
      } else if (mod.subType.endsWith("-tools") || mod.subType.includes("tools") ||
                 mod.subType.includes("kit") || mod.subType.includes("supplies") ||
                 mod.subType.includes("instrument") || mod.subType.includes("set")) {
        tools.add(displayName);
      } else if (mod.friendlySubtypeName && /^[A-Z]/.test(mod.friendlySubtypeName) &&
                 !mod.subType.includes("weapon") && !mod.subType.includes("armor")) {
        // Individual weapon proficiencies (e.g., "battleaxes", "handaxes") go to weapons
        weapons.add(displayName);
      } else {
        weapons.add(displayName); // Default: treat unknown proficiencies as weapon-like
      }
    }
  }

  const lines: string[] = [];
  if (armor.size > 0) lines.push(`Armor: ${[...armor].sort().join(", ")}`);
  if (weapons.size > 0) lines.push(`Weapons: ${[...weapons].sort().join(", ")}`);
  if (tools.size > 0) lines.push(`Tools: ${[...tools].sort().join(", ")}`);
  if (languages.size > 0) lines.push(`Languages: ${[...languages].sort().join(", ")}`);

  if (lines.length === 0) return StringUtils.EMPTY;

  return `\n--- Proficiencies ---\n${lines.join("\n")}`;
}

function formatSpellcasting(char: DdbCharacter): string {
  const allSpells = getAllSpells(char);

  if (allSpells.length === 0) return StringUtils.EMPTY;

  const SPELLCASTING_ABILITY: Record<string, number> = {
    "Wizard": 4, "Artificer": 4,  // INT
    "Sorcerer": 6, "Warlock": 6, "Bard": 6, "Paladin": 6,  // CHA
    "Cleric": 5, "Druid": 5, "Ranger": 5,  // WIS
  };

  const profBonus = calculateProficiencyBonus(computeLevel(char));
  const spellcastingClasses = char.classes.filter(cls => SPELLCASTING_ABILITY[cls.definition.name]);

  if (spellcastingClasses.length === 0) {
    // Fallback to WIS if no known spellcasting class
    const wisMod = getAbilityModNumeric(char, 5);
    const spellSaveDC = 8 + profBonus + wisMod;
    const spellAttack = profBonus + wisMod;
    const attackSign = spellAttack >= 0 ? "+" : "";
    return `Spell Save DC: ${spellSaveDC} | Spell Attack: ${attackSign}${spellAttack}`;
  }

  const dcStrings = spellcastingClasses.map(cls => {
    const abilityId = SPELLCASTING_ABILITY[cls.definition.name] ?? 5;
    const abilityMod = getAbilityModNumeric(char, abilityId);
    const spellSaveDC = 8 + profBonus + abilityMod;
    const spellAttack = profBonus + abilityMod;
    const attackSign = spellAttack >= 0 ? "+" : "";

    if (spellcastingClasses.length > 1) {
      return `${cls.definition.name}: DC ${spellSaveDC} (${attackSign}${spellAttack} attack)`;
    }
    return `Spell Save DC: ${spellSaveDC} | Spell Attack: ${attackSign}${spellAttack}`;
  });

  return dcStrings.join(" | ");
}

function formatLimitedUseResources(char: DdbCharacter): string {
  const resources: string[] = [];
  const actions = char.actions ?? {};

  for (const list of Object.values(actions)) {
    if (!Array.isArray(list)) continue;
    for (const action of list) {
      if (action.limitedUse) {
        const used = action.limitedUse.numberUsed;
        const max = action.limitedUse.maxUses;
        const remaining = max - used;
        const reset = action.limitedUse.resetTypeDescription || "unknown";
        resources.push(`  ${action.name}: ${remaining}/${max} (${reset})`);
      }
    }
  }

  return resources.length > 0 ? resources.join("\n") : "  None";
}

function formatFeatNames(char: DdbCharacter): string {
  if (!char.feats || char.feats.length === 0) return "None";
  return char.feats.map((f) => f.definition.name).join(", ");
}

function getActiveClassFeatures(char: DdbCharacter): Array<{ name: string; className: string; level: number }> {
  const seen = new Set<string>();
  const features: Array<{ name: string; className: string; level: number }> = [];

  for (const cls of char.classes) {
    const classFeatures = cls.classFeatures ?? [];
    for (const feature of classFeatures) {
      if (featureLevel(feature) <= cls.level && !seen.has(featureName(feature))) {
        seen.add(featureName(feature));
        features.push({
          name: featureName(feature),
          className: cls.definition.name,
          level: featureLevel(feature),
        });
      }
    }

    if (cls.subclassDefinition?.classFeatures) {
      for (const feature of cls.subclassDefinition.classFeatures) {
        if (featureLevel(feature) <= cls.level && !seen.has(featureName(feature))) {
          seen.add(featureName(feature));
          features.push({
            name: featureName(feature),
            className: `${cls.definition.name} (${cls.subclassDefinition.name})`,
            level: featureLevel(feature),
          });
        }
      }
    }
  }

  return features;
}

function formatClassFeatureNames(char: DdbCharacter): string {
  const features = getActiveClassFeatures(char);
  if (features.length === 0) return "None";
  return features.map((f) => f.name).join(", ");
}

function formatRacialTraitNames(char: DdbCharacter): string {
  const traits = char.race?.racialTraits ?? [];
  if (traits.length === 0) return "None";
  return traits.map((t) => t.definition.name).join(", ");
}

function formatSpeed(char: DdbCharacter): string {
  // Base walking speed for most races is 30 ft
  let baseSpeed = 30;

  // Check modifiers for speed bonuses
  let speedBonus = sumModifierBonuses(char.modifiers, "speed");
  speedBonus += sumModifierBonuses(char.modifiers, "unarmored-movement");
  speedBonus += sumModifierBonuses(char.modifiers, "innate-speed-walking");

  const totalSpeed = baseSpeed + speedBonus;
  return `Speed: ${totalSpeed} ft`;
}

function formatSpellSlots(char: DdbCharacter): string {
  if (!char.spellSlots || char.spellSlots.length === 0) {
    return StringUtils.EMPTY;
  }

  const lines = char.spellSlots
    .filter(slot => slot.available > 0)
    .map(slot => {
      const filled = "\u25CF".repeat(slot.available - slot.used);
      const empty = "\u25CB".repeat(slot.used);
      return `Level ${slot.level}: ${filled}${empty} (${slot.used}/${slot.available} used)`;
    });

  if (lines.length === 0) return StringUtils.EMPTY;

  let result = `\n--- Spell Slots ---\n${lines.join("\n")}`;

  // Add pact magic if available
  if (char.pactMagic && char.pactMagic.available > 0) {
    const filled = "\u25CF".repeat(char.pactMagic.available - char.pactMagic.used);
    const empty = "\u25CB".repeat(char.pactMagic.used);
    result += `\nPact Magic (Level ${char.pactMagic.level}): ${filled}${empty} (${char.pactMagic.used}/${char.pactMagic.available} used)`;
  }

  return result;
}

function formatHitDice(char: DdbCharacter): string {
  const hitDiceByClass: string[] = [];

  // Hit die type mapping
  const HIT_DIE_MAP: Record<string, string> = {
    "Barbarian": "d12",
    "Fighter": "d10",
    "Paladin": "d10",
    "Ranger": "d10",
    "Bard": "d8",
    "Cleric": "d8",
    "Druid": "d8",
    "Monk": "d8",
    "Rogue": "d8",
    "Warlock": "d8",
    "Artificer": "d8",
    "Sorcerer": "d6",
    "Wizard": "d6",
  };

  const hitDiceUsed = char.hitDiceUsed ?? 0;

  for (const cls of char.classes) {
    const hitDie = HIT_DIE_MAP[cls.definition.name] ?? "d8";
    const total = cls.level;
    hitDiceByClass.push(`${cls.definition.name}: ${total}${hitDie}`);
  }

  if (hitDiceByClass.length === 0) return StringUtils.EMPTY;

  return `\n--- Hit Dice ---\n${hitDiceByClass.join("\n")}${hitDiceUsed > 0 ? ` (${hitDiceUsed} used)` : ""}`;
}

function formatTraits(char: DdbCharacter): string {
  const traits = char.traits ?? {};
  const lines: string[] = [];

  if (traits.personalityTraits) lines.push(`Personality: ${traits.personalityTraits}`);
  if (traits.ideals) lines.push(`Ideals: ${traits.ideals}`);
  if (traits.bonds) lines.push(`Bonds: ${traits.bonds}`);
  if (traits.flaws) lines.push(`Flaws: ${traits.flaws}`);

  if (lines.length === 0) return StringUtils.EMPTY;

  return `\n--- Traits ---\n${lines.join("\n")}`;
}

function formatNotes(char: DdbCharacter): string {
  const notes = char.notes ?? {};
  const lines: string[] = [];

  if (notes.backstory) lines.push(`Backstory: ${notes.backstory}`);
  if (notes.personalPossessions) lines.push(`Personal Possessions: ${notes.personalPossessions}`);
  if (notes.otherNotes) lines.push(`Other Notes: ${notes.otherNotes}`);
  if (notes.allies) lines.push(`Allies: ${notes.allies}`);
  if (notes.organizations) lines.push(`Organizations: ${notes.organizations}`);

  if (lines.length === 0) return StringUtils.EMPTY;

  return `\n--- Notes ---\n${lines.join("\n")}`;
}

function formatCharacterSheet(char: DdbCharacter): string {
  const sections = [
    `=== ${char.name} ===`,
    `Race: ${(char.race?.fullName ?? "No species selected")}`,
    `Class: ${formatClasses(char)}`,
    `Level: ${computeLevel(char)} (Proficiency Bonus: +${calculateProficiencyBonus(computeLevel(char))})`,
    `Background: ${char.background?.definition?.name ?? "None"}`,
    `HP: ${formatHp(char)}`,
    `AC: ${calculateAc(char)}`,
    formatSpeed(char),
    StringUtils.EMPTY,
    `--- Ability Scores ---`,
    formatAbilityScores(char),
    StringUtils.EMPTY,
    `--- Saving Throws (* = proficient) ---`,
    formatSavingThrows(char),
    StringUtils.EMPTY,
    `--- Skills (* = proficient, ** = expertise) ---`,
    formatSkills(char),
  ];

  // Add proficiencies display (after skills, before spellcasting)
  const proficiencies = formatProficiencies(char);
  if (proficiencies) sections.push(proficiencies.trim());

  const spellcasting = formatSpellcasting(char);
  if (spellcasting) {
    sections.push(StringUtils.EMPTY, `--- Spellcasting ---`, spellcasting);
    const spells = formatSpells(char);
    if (spells) sections.push(spells.trim());

    // Add spell slots display
    const spellSlots = formatSpellSlots(char);
    if (spellSlots) sections.push(spellSlots.trim());
  }

  // Add hit dice display
  const hitDice = formatHitDice(char);
  if (hitDice) sections.push(hitDice.trim());

  sections.push(
    StringUtils.EMPTY,
    `--- Limited-Use Resources ---`,
    formatLimitedUseResources(char),
    StringUtils.EMPTY,
    `--- Feats ---`,
    formatFeatNames(char),
    StringUtils.EMPTY,
    `--- Class Features ---`,
    formatClassFeatureNames(char),
    StringUtils.EMPTY,
    `--- Racial Traits ---`,
    formatRacialTraitNames(char)
  );

  const inventory = formatInventory(char);
  if (inventory) sections.push(inventory);

  // Add traits display
  const traits = formatTraits(char);
  if (traits) sections.push(traits.trim());

  // Add notes display
  const notes = formatNotes(char);
  if (notes) sections.push(notes.trim());

  if (char.campaign) {
    sections.push(StringUtils.EMPTY, `Campaign: ${char.campaign.name}`);
  }

  return sections.join("\n");
}

// ============================================================================
// DEFINITION LOOKUP
// ============================================================================

interface DefinitionResult {
  type: string;
  name: string;
  source: string;
  text: string;
}

function formatSpellDefinition(spell: DdbSpell): string {
  const d = spell.definition;
  const ACTIVATION_TYPES: Record<number, string> = {
    1: "Action",
    3: "Bonus Action",
    6: "Reaction",
  };
  const components = (d.components ?? [])
    .map((c) => ({ 1: "V", 2: "S", 3: "M" })[c])
    .filter(Boolean)
    .join(", ");
  const materialNote = d.componentsDescription
    ? ` (${d.componentsDescription})`
    : "";

  const levelLabel = d.level === 0 ? "Cantrip" : `Level ${d.level}`;
  const castingTime = d.activation
    ? `${d.activation.activationTime} ${ACTIVATION_TYPES[d.activation.activationType] ?? "Action"}`
    : "1 Action";

  let range = "Self";
  if (d.range) {
    if (d.range.rangeValue && d.range.origin !== "Self") {
      range = `${d.range.rangeValue} ft`;
    } else {
      range = d.range.origin;
    }
    if (d.range.aoeType && d.range.aoeValue) {
      range += ` (${d.range.aoeValue}-ft ${d.range.aoeType})`;
    }
  }

  let duration = "Instantaneous";
  if (d.duration) {
    const interval = d.duration.durationInterval;
    const unit = d.duration.durationUnit;
    const isConcentration = d.duration.durationType === "Concentration";
    if (interval && unit) {
      duration = `${isConcentration ? "Concentration, up to " : ""}${interval} ${unit}${interval > 1 ? "s" : ""}`;
    } else if (isConcentration) {
      duration = "Concentration";
    }
  }

  const lines = [
    `${d.name} (${levelLabel} ${d.school})`,
    `Casting Time: ${castingTime}`,
    `Range: ${range}`,
    `Components: ${components || "None"}${materialNote}`,
    `Duration: ${duration}`,
  ];
  if (d.ritual) lines.push("Ritual: Yes");
  lines.push(StringUtils.EMPTY, stripHtml(d.description));
  return lines.join("\n");
}

function formatFeatDefinition(feat: DdbFeat): string {
  const d = feat.definition;
  const lines = [d.name];
  if (d.prerequisite) lines.push(`Prerequisite: ${d.prerequisite}`);
  lines.push(StringUtils.EMPTY, stripHtml(d.description));
  return lines.join("\n");
}

function formatClassFeatureDefinition(feature: DdbClassFeature, className: string): string {
  const lines = [
    `${featureName(feature)} (${className}, Level ${featureLevel(feature)})`,
    StringUtils.EMPTY,
    stripHtml(featureDescription(feature)),
  ];
  return lines.join("\n");
}

function formatRacialTraitDefinition(trait: DdbRacialTrait, raceName: string): string {
  const d = trait.definition;
  return `${d.name} (${raceName})\n\n${stripHtml(d.description)}`;
}

function formatItemDefinition(item: DdbInventoryItem): string {
  const d = item.definition;
  const lines = [
    `${d.name} (${d.type}, ${d.rarity})`,
    `Weight: ${d.weight} lb`,
  ];
  lines.push(StringUtils.EMPTY, stripHtml(d.description));
  return lines.join("\n");
}

function searchDefinitions(char: DdbCharacter, query: string): DefinitionResult[] {
  const results: DefinitionResult[] = [];
  const q = query.toLowerCase();

  // Search spells
  const allSpells = getAllSpells(char);
  for (const spell of allSpells) {
    if (spell.definition.name.toLowerCase().includes(q)) {
      results.push({
        type: "Spell",
        name: spell.definition.name,
        source: `Level ${spell.definition.level} ${spell.definition.school}`,
        text: formatSpellDefinition(spell),
      });
    }
  }

  // Search feats
  for (const feat of char.feats ?? []) {
    if (feat.definition.name.toLowerCase().includes(q)) {
      results.push({
        type: "Feat",
        name: feat.definition.name,
        source: "Feat",
        text: formatFeatDefinition(feat),
      });
    }
  }

  // Search active class features (respecting level filter)
  const seen = new Set<string>();
  for (const cls of char.classes) {
    for (const feature of cls.classFeatures ?? []) {
      if (
        featureLevel(feature) <= cls.level &&
        featureName(feature).toLowerCase().includes(q) &&
        !seen.has(featureName(feature))
      ) {
        seen.add(featureName(feature));
        results.push({
          type: "Class Feature",
          name: featureName(feature),
          source: `${cls.definition.name} (Level ${featureLevel(feature)})`,
          text: formatClassFeatureDefinition(feature, cls.definition.name),
        });
      }
    }

    if (cls.subclassDefinition?.classFeatures) {
      for (const feature of cls.subclassDefinition.classFeatures) {
        if (
          featureLevel(feature) <= cls.level &&
          featureName(feature).toLowerCase().includes(q) &&
          !seen.has(featureName(feature))
        ) {
          seen.add(featureName(feature));
          results.push({
            type: "Subclass Feature",
            name: featureName(feature),
            source: `${cls.definition.name} / ${cls.subclassDefinition.name} (Level ${featureLevel(feature)})`,
            text: formatClassFeatureDefinition(feature, `${cls.definition.name} (${cls.subclassDefinition.name})`),
          });
        }
      }
    }
  }

  // Search racial traits
  for (const trait of char.race?.racialTraits ?? []) {
    if (trait.definition.name.toLowerCase().includes(q)) {
      results.push({
        type: "Racial Trait",
        name: trait.definition.name,
        source: (char.race?.fullName ?? "No species selected"),
        text: formatRacialTraitDefinition(trait, (char.race?.fullName ?? "No species selected")),
      });
    }
  }

  // Search background feature
  const bgDef = char.background?.definition;
  if (bgDef?.featureName && bgDef.featureName.toLowerCase().includes(q)) {
    results.push({
      type: "Background Feature",
      name: bgDef.featureName,
      source: bgDef.name,
      text: `${bgDef.featureName} (${bgDef.name})\n\n${stripHtml(bgDef.featureDescription)}`,
    });
  }

  // Search equipped items
  for (const item of char.inventory.filter((i) => i.equipped)) {
    if (item.definition.name.toLowerCase().includes(q)) {
      results.push({
        type: "Item",
        name: item.definition.name,
        source: `${item.definition.type}, ${item.definition.rarity}`,
        text: formatItemDefinition(item),
      });
    }
  }

  return results;
}

// ============================================================================
// FULL CHARACTER SHEET (WITH ALL DEFINITIONS)
// ============================================================================

function formatCharacterFull(char: DdbCharacter): string {
  const sheet = formatCharacterSheet(char);
  const definitionSections: string[] = [];

  // Spells
  const allSpells = getAllSpells(char);
  const preparedSpells = allSpells.filter((s) => s.prepared || s.alwaysPrepared);
  if (preparedSpells.length > 0) {
    const spellDefs = preparedSpells
      .sort((a, b) => a.definition.level - b.definition.level || a.definition.name.localeCompare(b.definition.name))
      .map((s) => formatSpellDefinition(s));
    definitionSections.push(`\n=== Spell Definitions ===\n\n${spellDefs.join("\n\n---\n\n")}`);
  }

  // Feats
  if (char.feats && char.feats.length > 0) {
    const featDefs = char.feats.map((f) => formatFeatDefinition(f));
    definitionSections.push(`\n=== Feat Definitions ===\n\n${featDefs.join("\n\n---\n\n")}`);
  }

  // Active class features
  const activeFeatures = getActiveClassFeatures(char);
  if (activeFeatures.length > 0) {
    const featureDefs: string[] = [];
    const seen = new Set<string>();

    for (const cls of char.classes) {
      for (const feature of cls.classFeatures ?? []) {
        if (featureLevel(feature) <= cls.level && !seen.has(featureName(feature))) {
          seen.add(featureName(feature));
          featureDefs.push(formatClassFeatureDefinition(feature, cls.definition.name));
        }
      }

      if (cls.subclassDefinition?.classFeatures) {
        for (const feature of cls.subclassDefinition.classFeatures) {
          if (featureLevel(feature) <= cls.level && !seen.has(featureName(feature))) {
            seen.add(featureName(feature));
            featureDefs.push(
              formatClassFeatureDefinition(feature, `${cls.definition.name} (${cls.subclassDefinition.name})`)
            );
          }
        }
      }
    }

    if (featureDefs.length > 0) {
      definitionSections.push(`\n=== Class Feature Definitions ===\n\n${featureDefs.join("\n\n---\n\n")}`);
    }
  }

  // Racial traits
  const traits = char.race?.racialTraits ?? [];
  if (traits.length > 0) {
    const traitDefs = traits.map((t) => formatRacialTraitDefinition(t, (char.race?.fullName ?? "No species selected")));
    definitionSections.push(`\n=== Racial Trait Definitions ===\n\n${traitDefs.join("\n\n---\n\n")}`);
  }

  // Background feature
  const bgDef = char.background?.definition;
  if (bgDef?.featureName) {
    definitionSections.push(
      `\n=== Background Feature ===\n\n${bgDef.featureName} (${bgDef.name})\n\n${stripHtml(bgDef.featureDescription)}`
    );
  }

  // Equipped items with descriptions
  const equippedItems = char.inventory.filter((i) => i.equipped);
  if (equippedItems.length > 0) {
    const itemDefs = equippedItems.map((i) => formatItemDefinition(i));
    definitionSections.push(`\n=== Equipped Item Definitions ===\n\n${itemDefs.join("\n\n---\n\n")}`);
  }

  return sheet + "\n" + definitionSections.join("\n");
}

// ============================================================================
// BASIC CHARACTER FORMAT (original)
// ============================================================================

function formatCharacter(char: DdbCharacter): string {
  const sections = [
    `Name: ${char.name}`,
    `Race: ${(char.race?.fullName ?? "No species selected")}`,
    `Class: ${formatClasses(char)}`,
    `Level: ${computeLevel(char)}`,
    `HP: ${formatHp(char)}`,
    `AC: ${calculateAc(char)}`,
    `\nAbility Scores:\n${formatAbilityScores(char)}`,
  ];

  if (char.campaign) {
    sections.push(`\nCampaign: ${char.campaign.name}`);
  }

  const spells = formatSpells(char);
  if (spells) sections.push(spells);

  const inventory = formatInventory(char);
  if (inventory) sections.push(inventory);

  return sections.join("\n");
}

// Fetch all characters owned by the authenticated user directly from
// character-service. This replaces the previous campaign-traversal approach,
// which missed characters not in a campaign and relied on the campaign-list
// endpoint still returning inline characters (it no longer does).
interface UserCharacterListEntry {
  id: number;
  name: string;
  level: number;
  raceName?: string;
  classDescription?: string;
  campaignName?: string;
}

async function fetchUserCharacters(client: DdbClient): Promise<UserCharacterListEntry[]> {
  const userId = await getUserId();
  if (userId == null) return [];
  const data = await client.get<{ characters?: UserCharacterListEntry[] }>(
    ENDPOINTS.character.list(userId),
    `characters:list:${userId}`,
    300_000
  );
  return data?.characters ?? [];
}

type NamedCharacter = { id: number; name: string };

// Exact (case-insensitive) → unique substring → unique fuzzy (Levenshtein) match.
// Returns null when there is no match or the match is ambiguous.
function matchCharacterByName(candidates: NamedCharacter[], name: string): number | null {
  // 1. Exact match (case-insensitive)
  const exactMatch = candidates.find(
    (char) => char.name.toLowerCase() === name.toLowerCase()
  );
  if (exactMatch) return exactMatch.id;

  // 2. Substring match (case-insensitive)
  const lowerName = name.toLowerCase();
  const substringMatches = candidates.filter(
    (char) => char.name.toLowerCase().includes(lowerName)
  );
  if (substringMatches.length === 1) return substringMatches[0].id;

  // 3. Fuzzy match via Levenshtein distance — check full names and individual words
  const fuzzyResults: NamedCharacter[] = [];
  for (const char of candidates) {
    const fullDistance = levenshteinDistance(lowerName, char.name.toLowerCase());
    if (fullDistance <= 3) {
      fuzzyResults.push(char);
      continue;
    }
    // Check individual words (e.g., "Throin" matches "Thorin" in "Thorin Ironforge")
    const words = char.name.split(/\s+/);
    for (const word of words) {
      if (levenshteinDistance(lowerName, word.toLowerCase()) <= 3) {
        fuzzyResults.push(char);
        break;
      }
    }
  }
  if (fuzzyResults.length === 1) return fuzzyResults[0].id;

  return null;
}

// Party members across the user's active campaigns (other players' shared characters).
// Reuses the same cache keys as the campaign tools so rosters are fetched at most once.
async function fetchCampaignRosterCharacters(client: DdbClient): Promise<NamedCharacter[]> {
  const campaigns = await client.get<DdbCampaign[]>(
    ENDPOINTS.campaign.list(),
    "campaigns",
    5 * 60 * 1000
  );
  const roster: NamedCharacter[] = [];
  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    const characters = await client.get<DdbCampaignCharacter2[]>(
      ENDPOINTS.campaign.characters(campaign.id),
      `campaign:${campaign.id}:characters`,
      5 * 60 * 1000
    );
    for (const character of Array.isArray(characters) ? characters : []) {
      roster.push({ id: character.id, name: character.name.trim() });
    }
  }
  return roster;
}

async function findCharacterByName(client: DdbClient, name: string): Promise<number | null> {
  // 1. Match against the user's own characters first (cheapest, most common case).
  const own = (await fetchUserCharacters(client)).map((c) => ({
    id: c.id,
    name: c.name.trim(),
  }));
  const ownMatch = matchCharacterByName(own, name);
  if (ownMatch != null) return ownMatch;

  // 2. Fall back to party members across active campaigns (other players' characters).
  //    Dedupe by id so own characters already tried aren't matched twice.
  const ownIds = new Set(own.map((c) => c.id));
  const roster = (await fetchCampaignRosterCharacters(client)).filter(
    (c) => !ownIds.has(c.id)
  );
  return matchCharacterByName(roster, name);
}

export async function getCharacter(
  client: DdbClient,
  params: GetCharacterParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const idOrError = await resolveCharacterId(client, params);
  if (typeof idOrError === "string") {
    return { content: [{ type: "text", text: idOrError }] };
  }

  const { value: character, fromCache, ageMs } = await client.getWithMeta<DdbCharacter>(
    ENDPOINTS.character.get(idOrError),
    `character:${idOrError}`,
    60_000,
    params.forceRefresh ?? false
  );

  const detail = params.detail ?? "sheet";
  let text: string;
  switch (detail) {
    case "summary":
      text = formatCharacter(character);
      break;
    case "full":
      text = formatCharacterFull(character);
      break;
    case "sheet":
    default:
      text = formatCharacterSheet(character);
      break;
  }

  return { content: [{ type: "text", text: text + formatFreshness(character, fromCache, ageMs) }] };
}

// ============================================================================
// CHOICE INSPECTION (read-only)
// ============================================================================

const CHOICE_CATEGORIES = ["class", "race", "background", "feat"] as const;

type ChoiceOption = { id: number; label: string };

function buildChoiceOptionMap(choices: any): Map<string, ChoiceOption[]> {
  const map = new Map<string, ChoiceOption[]>();
  for (const def of choices?.choiceDefinitions ?? []) {
    if (def?.id && Array.isArray(def.options)) map.set(def.id, def.options);
  }
  return map;
}

// Best-effort friendly name for the feature/feat a choice belongs to.
function choiceComponentLabel(choice: any, category: string, char: DdbCharacter): string | null {
  const cid = choice?.componentId;
  if (cid == null) return null;
  if (category === "feat") {
    const feat = (char.feats ?? []).find((f) => f.definition?.id === cid);
    if (feat?.definition?.name) return feat.definition.name;
  }
  const opts = (char as any).options?.[category] ?? [];
  const match = opts.find((o: any) => o.componentId === cid);
  if (match?.definition?.name) return match.definition.name;
  return null;
}

/**
 * Inspect a character's builder choices with their resolved values, available
 * options, and the exact ids needed to (re)resolve each one. Surfaces in a
 * single call what is otherwise hidden by the formatted sheet — e.g. which
 * choice grants a skill proficiency, or whether a meaningful pick is unresolved.
 */
export async function getCharacterChoices(
  client: DdbClient,
  params: GetCharacterParams
): Promise<ToolResult> {
  const idOrError = await resolveCharacterId(client, params);
  if (typeof idOrError === "string") {
    return { content: [{ type: "text", text: idOrError }] };
  }

  const char = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(idOrError),
    `character:${idOrError}`,
    60_000
  );

  const choices = (char as any).choices ?? {};
  const optMap = buildChoiceOptionMap(choices);

  // Map each class feature id -> its owning class's ids, so a class choice gets
  // the correct classId/classMappingId even on a multiclass character (a choice
  // on the 2nd class must not inherit the 1st class's ids).
  const classByFeatureId = new Map<number, { classId?: number; classMappingId?: number }>();
  const classSummaries: string[] = [];
  for (const c of char.classes ?? []) {
    const ids = { classId: c.definition?.id, classMappingId: (c as { id?: number }).id };
    classSummaries.push(`${c.definition?.name ?? "?"}: classId=${ids.classId ?? "?"} classMappingId=${ids.classMappingId ?? "?"}`);
    const feats = (c as { classFeatures?: Array<{ id?: number; definition?: { id?: number } }> }).classFeatures ?? [];
    for (const f of feats) {
      const fid = f.definition?.id ?? f.id;
      if (fid != null) classByFeatureId.set(fid, ids);
    }
  }
  const fallbackClassIds = { classId: char.classes?.[0]?.definition?.id, classMappingId: (char.classes?.[0] as { id?: number })?.id };

  const sections: string[] = [
    `=== Choices: ${char.name} (id ${idOrError}) ===`,
    `Resolve with set_class_feature_choice / set_feat_choice / set_race_trait_choice / set_background_choice using the ids shown.`,
  ];

  let total = 0;
  let unresolved = 0;

  for (const category of CHOICE_CATEGORIES) {
    const list = choices[category];
    if (!Array.isArray(list) || list.length === 0) continue;

    const header =
      category === "class" && classSummaries.length
        ? `CLASS  (${classSummaries.join("; ")})`
        : category.toUpperCase();
    const lines: string[] = [header];

    for (const ch of list) {
      total++;
      const options = optMap.get(`${ch.componentTypeId}-${ch.type}`) ?? [];
      const labelOf = (id: number) => options.find((o) => o.id === id)?.label ?? String(id);
      const resolved = ch.optionValue != null;
      if (!resolved) unresolved++;
      const marker = resolved ? "✓" : "✗";
      const compLabel = choiceComponentLabel(ch, category, char);
      const title = [compLabel, ch.label].filter(Boolean).join(" — ") || "(choice)";
      const resolvedLabel = resolved ? labelOf(ch.optionValue) : "UNRESOLVED";

      lines.push(`  [${marker}] ${title} → ${resolvedLabel}`);
      if (category === "class") {
        const owner = classByFeatureId.get(ch.componentId) ?? fallbackClassIds;
        lines.push(`       classId=${owner.classId ?? "?"} classMappingId=${owner.classMappingId ?? "?"} classFeatureId=${ch.componentId} type=${ch.type} choiceKey="${ch.id}"`);
      } else {
        const idKey = category === "feat" ? "featId" : category === "race" ? "racialTraitId" : "componentId";
        lines.push(`       ${idKey}=${ch.componentId} type=${ch.type} choiceKey="${ch.id}"`);
      }
      // Always emit every option id — large pools (skills are small, but spell/
      // language/ability pools can be 100+) are exactly the ones an agent needs
      // a concrete choiceValue for, so a count-only fallback would defeat the tool.
      if (options.length > 0) {
        const opts = options
          .map((o) => `${o.id} ${o.label}${o.id === ch.optionValue ? " ✓" : ""}`)
          .join(" | ");
        lines.push(`       options: ${opts}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  sections.push(`Total choices: ${total} | unresolved: ${unresolved}`);
  return { content: [{ type: "text", text: sections.join("\n\n") }] };
}

export async function listCharacters(
  client: DdbClient
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const characters = await fetchUserCharacters(client);

  if (characters.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No characters found.",
        },
      ],
    };
  }

  const lines = characters.map((c) => {
    const descriptor = [c.raceName, c.classDescription].filter(Boolean).join(" ").trim();
    const campaign = c.campaignName ? ` - ${c.campaignName}` : "";
    return `${c.name.trim()} - ${descriptor} (Level ${c.level})${campaign}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Characters:\n${lines.join("\n")}`,
      },
    ],
  };
}

// ============================================================================
// DEFINITION LOOKUP TOOL
// ============================================================================

export async function getDefinition(
  client: DdbClient,
  params: GetDefinitionParams
): Promise<ToolResult> {
  const idOrError = await resolveCharacterId(client, params);
  if (typeof idOrError === "string") {
    return { content: [{ type: "text", text: idOrError }] };
  }

  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(idOrError),
    `character:${idOrError}`,
    60_000
  );

  const results = searchDefinitions(character, params.name);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No definition found matching "${params.name}" on ${character.name}.`,
        },
      ],
    };
  }

  const formatted = results.map((r) => `[${r.type}] ${r.text}`).join("\n\n===\n\n");
  return { content: [{ type: "text", text: formatted }] };
}


class StringUtils {
  static readonly EMPTY = "";
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

interface UpdateHpParams {
  characterId: number;
  hpChange: number;
  tempHp?: number;
}

export async function updateHp(
  client: DdbClient,
  params: UpdateHpParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // HP is a delta-write: removedHitPoints is computed from the character's
  // CURRENT value, so a stale cached read would set the wrong absolute HP
  // (e.g. if the player changed HP in the DDB app meanwhile). Read fresh.
  client.invalidateCache(`character:${params.characterId}`);
  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `character:${params.characterId}`,
    60_000
  );

  const newRemovedHp = Math.max(
    0,
    Math.min(
      calculateMaxHp(character),
      character.removedHitPoints - params.hpChange
    )
  );

  // temporaryHitPoints is a REQUIRED field on the damage-taken endpoint — omitting
  // it yields 400 "Missing required field: temporaryHitPoints" (verified via the
  // response body). Preserve the character's current temp HP when the caller
  // didn't explicitly set one.
  const putBody = {
    characterId: params.characterId,
    removedHitPoints: newRemovedHp,
    temporaryHitPoints: params.tempHp ?? character.temporaryHitPoints,
  };

  await client.put(
    ENDPOINTS.character.updateHp(),
    putBody,
    [`character:${params.characterId}`]
  );

  const action = params.hpChange > 0 ? "Healed" : "Damaged";
  const amount = Math.abs(params.hpChange);
  const newCurrent = calculateMaxHp(character) - newRemovedHp;

  let text = `${action} ${character.name} for ${amount} HP. Current HP: ${newCurrent}/${calculateMaxHp(character)}`;
  if (params.tempHp !== undefined) {
    text += ` (${params.tempHp} temp HP)`;
  }

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

interface SetInspirationParams {
  characterId: number;
  inspiration: boolean;
}

export async function setInspiration(
  client: DdbClient,
  params: SetInspirationParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setInspiration(),
    { characterId: params.characterId, inspiration: params.inspiration },
    [`character:${params.characterId}`]
  );
  const state = params.inspiration ? "granted" : "removed";
  return { content: [{ type: "text", text: `Inspiration ${state} for character ${params.characterId}.` }] };
}

interface AddConditionParams {
  characterId: number;
  conditionId: number;
  level?: number | null;
}

const CONDITION_NAMES: Record<number, string> = {
  1: "Blinded", 2: "Charmed", 3: "Deafened", 4: "Frightened",
  5: "Grappled", 6: "Incapacitated", 7: "Invisible", 8: "Paralyzed",
  9: "Petrified", 10: "Poisoned", 11: "Prone", 12: "Restrained",
  13: "Stunned", 14: "Unconscious", 15: "Exhaustion",
};

export async function addCondition(
  client: DdbClient,
  params: AddConditionParams
): Promise<ToolResult> {
  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `character:${params.characterId}`,
    60_000
  );
  const maxHp = calculateMaxHp(character);

  await client.put(
    ENDPOINTS.character.condition(),
    {
      characterId: params.characterId,
      id: params.conditionId,
      level: params.level ?? null,
      totalHp: maxHp,
    },
    [`character:${params.characterId}`]
  );

  const name = CONDITION_NAMES[params.conditionId] ?? `Condition ${params.conditionId}`;
  const levelText = params.level ? ` (level ${params.level})` : "";
  return { content: [{ type: "text", text: `Added ${name}${levelText} to character ${params.characterId}.` }] };
}

interface RemoveConditionParams {
  characterId: number;
  conditionId: number;
}

export async function removeCondition(
  client: DdbClient,
  params: RemoveConditionParams
): Promise<ToolResult> {
  await client.delete(
    ENDPOINTS.character.condition(),
    { characterId: params.characterId, id: params.conditionId },
    [`character:${params.characterId}`]
  );

  const name = CONDITION_NAMES[params.conditionId] ?? `Condition ${params.conditionId}`;
  return { content: [{ type: "text", text: `Removed ${name} from character ${params.characterId}.` }] };
}

interface UpdateSpellSlotsParams {
  characterId: number;
  level: number;
  used: number;
}

export async function updateSpellSlots(
  client: DdbClient,
  params: UpdateSpellSlotsParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (params.level < 1 || params.level > 9) {
    return {
      content: [
        {
          type: "text",
          text: "Spell slot level must be between 1 and 9.",
        },
      ],
    };
  }

  if (params.used < 0) {
    return {
      content: [
        {
          type: "text",
          text: "Used spell slots cannot be negative.",
        },
      ],
    };
  }

  try {
    await client.put(
      ENDPOINTS.character.updateSpellSlots(params.characterId),
      { level: params.level, used: params.used },
      [`character:${params.characterId}`]
    );

    return {
      content: [
        {
          type: "text",
          text: `Updated level ${params.level} spell slots to ${params.used} used.`,
        },
      ],
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️  Spell slot updates are temporarily unavailable.\n\nD&D Beyond has deprecated the v5 character write API endpoints. This feature cannot be used until D&D Beyond provides replacement endpoints.\n\nCharacter ID: ${params.characterId}\nRead operations still work normally.`,
          },
        ],
      };
    }
    throw error;
  }
}

interface UpdateDeathSavesParams {
  characterId: number;
  type: "success" | "failure";
  count: number;
}

export async function updateDeathSaves(
  client: DdbClient,
  params: UpdateDeathSavesParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!["success", "failure"].includes(params.type)) {
    return {
      content: [
        {
          type: "text",
          text: "Death save type must be 'success' or 'failure'.",
        },
      ],
    };
  }

  if (params.count < 0 || params.count > 3) {
    return {
      content: [
        {
          type: "text",
          text: "Death save count must be between 0 and 3.",
        },
      ],
    };
  }

  const body =
    params.type === "success"
      ? { successCount: params.count }
      : { failCount: params.count };

  try {
    await client.put(
      ENDPOINTS.character.updateDeathSaves(params.characterId),
      body,
      [`character:${params.characterId}`]
    );

    return {
      content: [
        {
          type: "text",
          text: `Updated death saves: ${params.count} ${params.type}${params.count === 1 ? StringUtils.EMPTY : "es"}.`,
        },
      ],
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️  Death save updates are temporarily unavailable.\n\nD&D Beyond has deprecated the v5 character write API endpoints. This feature cannot be used until D&D Beyond provides replacement endpoints.\n\nCharacter ID: ${params.characterId}\nRead operations still work normally.`,
          },
        ],
      };
    }
    throw error;
  }
}

interface UpdateCurrencyParams {
  characterId: number;
  currency: "cp" | "sp" | "ep" | "gp" | "pp";
  amount?: number;
  delta?: number;
}

export async function updateCurrency(
  client: DdbClient,
  params: UpdateCurrencyParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const validCurrencies = ["cp", "sp", "ep", "gp", "pp"];
  if (!validCurrencies.includes(params.currency)) {
    return {
      content: [
        {
          type: "text",
          text: "Currency must be one of: cp, sp, ep, gp, pp.",
        },
      ],
    };
  }

  if (params.amount === undefined && params.delta === undefined) {
    return {
      content: [{ type: "text", text: "Either amount or delta must be provided." }],
    };
  }

  // The current currency write endpoint (/inventory/currency) replaces the full
  // currency object, so fetch the existing values, change the requested one, and
  // send all five. (The old per-character path is deprecated and returns 404.)
  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `character:${params.characterId}`,
    60_000
  );
  const currencies = {
    cp: character.currencies?.cp ?? 0,
    sp: character.currencies?.sp ?? 0,
    gp: character.currencies?.gp ?? 0,
    ep: character.currencies?.ep ?? 0,
    pp: character.currencies?.pp ?? 0,
  };
  const current = currencies[params.currency];

  let finalAmount: number;
  let description: string;
  if (params.delta !== undefined) {
    finalAmount = Math.max(0, current + params.delta);
    description =
      params.delta >= 0
        ? `Added ${params.delta} ${params.currency.toUpperCase()} (${current} → ${finalAmount})`
        : `Spent ${Math.abs(params.delta)} ${params.currency.toUpperCase()} (${current} → ${finalAmount})`;
  } else {
    finalAmount = params.amount!;
    description = `Set ${params.currency.toUpperCase()} to ${finalAmount}`;
  }
  currencies[params.currency] = finalAmount;

  await client.put(
    ENDPOINTS.character.inventory.currency(),
    { characterId: params.characterId, ...currencies },
    [`character:${params.characterId}`]
  );

  return {
    content: [{ type: "text", text: `${description}.` }],
  };
}

interface UpdatePactMagicParams {
  characterId: number;
  used: number;
}

interface LongRestParams {
  characterId: number;
}

interface ShortRestParams {
  characterId: number;
}

interface UseAbilityParams {
  characterId: number;
  abilityName: string;
  uses?: number;
}

export async function updatePactMagic(
  client: DdbClient,
  params: UpdatePactMagicParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (params.used < 0) {
    return {
      content: [
        {
          type: "text",
          text: "Used pact magic slots cannot be negative.",
        },
      ],
    };
  }

  try {
    await client.put(
      ENDPOINTS.character.updatePactMagic(params.characterId),
      { used: params.used },
      [`character:${params.characterId}`]
    );

    return {
      content: [
        {
          type: "text",
          text: `Updated pact magic slots to ${params.used} used.`,
        },
      ],
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️  Pact magic updates are temporarily unavailable.\n\nD&D Beyond has deprecated the v5 character write API endpoints. This feature cannot be used until D&D Beyond provides replacement endpoints.\n\nCharacter ID: ${params.characterId}\nRead operations still work normally.`,
          },
        ],
      };
    }
    throw error;
  }
}

export async function longRest(
  client: DdbClient,
  params: LongRestParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Server-side long rest handles all resets atomically:
  // HP, spell slots, pact magic, limited-use abilities, hit dice, death saves
  await client.get<unknown>(
    ENDPOINTS.character.rest.long(params.characterId),
    `rest:long:${params.characterId}:${Date.now()}`,
    0
  );
  client.invalidateCache(`character:${params.characterId}`);

  return {
    content: [
      {
        type: "text",
        text: `Long rest completed for character ${params.characterId}. All HP, spell slots, and long-rest abilities have been restored.`,
      },
    ],
  };
}

export async function shortRest(
  client: DdbClient,
  params: ShortRestParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Server-side short rest handles pact magic, short-rest abilities, hit dice
  await client.get<unknown>(
    ENDPOINTS.character.rest.short(params.characterId),
    `rest:short:${params.characterId}:${Date.now()}`,
    0
  );
  client.invalidateCache(`character:${params.characterId}`);

  return {
    content: [
      {
        type: "text",
        text: `Short rest completed for character ${params.characterId}. Pact magic and short-rest abilities have been restored.`,
      },
    ],
  };
}

interface CastSpellParams {
  characterId: number;
  spellName: string;
  level?: number;
}

export async function castSpell(
  client: DdbClient,
  params: CastSpellParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!params.spellName || params.spellName.trim() === StringUtils.EMPTY) {
    return {
      content: [{ type: "text", text: "Spell name cannot be empty." }],
    };
  }

  try {
    const character = await client.get<DdbCharacter>(
      ENDPOINTS.character.get(params.characterId),
      `character:${params.characterId}`,
      60_000
    );

    // Find the spell in character's spell lists
    const allSpells = getAllSpells(character);
    const spellNameLower = params.spellName.toLowerCase();
    const spell = allSpells.find(
      (s) => s.definition.name.toLowerCase() === spellNameLower
    );

    if (!spell) {
      // Try fuzzy match
      const spellNames = allSpells.map(s => s.definition.name);
      const matches = fuzzyMatch(params.spellName, spellNames, 3);
      if (matches.length > 0) {
        return {
          content: [{
            type: "text",
            text: `Spell "${params.spellName}" not found. Did you mean: ${matches.join(", ")}?`,
          }],
        };
      }
      return {
        content: [{ type: "text", text: `Spell "${params.spellName}" not found on this character.` }],
      };
    }

    const spellLevel = params.level ?? spell.definition.level;

    // Cantrips don't use spell slots
    if (spellLevel === 0) {
      return {
        content: [{ type: "text", text: `Cast ${spell.definition.name} (cantrip) — no spell slot required.` }],
      };
    }

    // Determine if warlock using pact magic
    const isWarlock = character.classes.some(cls => cls.definition.name === "Warlock");
    const hasPactMagic = character.pactMagic && character.pactMagic.available > 0;

    if (isWarlock && hasPactMagic && spellLevel <= character.pactMagic!.level) {
      // Use pact magic slot
      const newUsed = character.pactMagic!.used + 1;
      if (newUsed > character.pactMagic!.available) {
        return {
          content: [{ type: "text", text: `No pact magic slots remaining (${character.pactMagic!.used}/${character.pactMagic!.available} used).` }],
        };
      }
      await client.put(
        ENDPOINTS.character.updatePactMagic(params.characterId),
        { used: newUsed },
        [`character:${params.characterId}`]
      );
      return {
        content: [{
          type: "text",
          text: `Cast ${spell.definition.name} using pact magic (level ${character.pactMagic!.level}). Pact slots: ${newUsed}/${character.pactMagic!.available} used.`,
        }],
      };
    }

    // Use regular spell slot
    const slotData = character.spellSlots?.find(s => s.level === spellLevel);
    if (slotData) {
      const newUsed = slotData.used + 1;
      if (newUsed > slotData.available) {
        return {
          content: [{ type: "text", text: `No level ${spellLevel} spell slots remaining (${slotData.used}/${slotData.available} used).` }],
        };
      }
      await client.put(
        ENDPOINTS.character.updateSpellSlots(params.characterId),
        { level: spellLevel, used: newUsed },
        [`character:${params.characterId}`]
      );
      return {
        content: [{
          type: "text",
          text: `Cast ${spell.definition.name} at level ${spellLevel}. Level ${spellLevel} slots: ${newUsed}/${slotData.available} used.`,
        }],
      };
    }

    // No slot data available — just update the slot count
    await client.put(
      ENDPOINTS.character.updateSpellSlots(params.characterId),
      { level: spellLevel, used: 1 },
      [`character:${params.characterId}`]
    );
    return {
      content: [{
        type: "text",
        text: `Cast ${spell.definition.name} at level ${spellLevel}. Updated level ${spellLevel} spell slot usage.`,
      }],
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️  Spell casting operations are temporarily unavailable.\n\nD&D Beyond has deprecated the v5 character write API endpoints. This feature cannot be used until D&D Beyond provides replacement endpoints.\n\nCharacter ID: ${params.characterId}\nRead operations still work normally.`,
          },
        ],
      };
    }
    throw error;
  }
}

export async function useAbility(
  client: DdbClient,
  params: UseAbilityParams
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!params.abilityName || params.abilityName.trim() === StringUtils.EMPTY) {
    return {
      content: [{ type: "text", text: "Ability name cannot be empty." }],
    };
  }

  // Fetch character data to find the action's id and entityTypeId
  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `character:${params.characterId}`,
    60_000
  );

  // Collect all actions into a flat list
  const actions = character.actions ?? {};
  const allActions: DdbAction[] = [];
  for (const list of Object.values(actions)) {
    if (Array.isArray(list)) allActions.push(...list);
  }

  // Try exact match first (case-insensitive)
  let foundAction: DdbAction | null = allActions.find(
    (a) => a.name?.toLowerCase() === params.abilityName.toLowerCase()
  ) ?? null;

  // Fall back to fuzzy matching
  if (!foundAction) {
    const actionNames = allActions.filter(a => a.name).map(a => a.name);
    const matches = fuzzyMatch(params.abilityName, actionNames, 3);

    if (matches.length === 1) {
      // Single close match — use it
      foundAction = allActions.find(a => a.name === matches[0]) ?? null;
    } else if (matches.length > 1) {
      return {
        content: [{
          type: "text",
          text: `Ability "${params.abilityName}" not found. Did you mean one of: ${matches.join(", ")}?`,
        }],
      };
    }
  }

  if (!foundAction) {
    const actionNames = allActions.filter(a => a.name).map(a => a.name);
    const available = actionNames.length > 0 ? `\nAvailable abilities: ${actionNames.join(", ")}` : "";
    return {
      content: [{
        type: "text",
        text: `Ability "${params.abilityName}" not found in character actions.${available}`,
      }],
    };
  }

  if (!foundAction.limitedUse) {
    return {
      content: [
        {
          type: "text",
          text: `"${foundAction.name}" does not have limited uses.`,
        },
      ],
    };
  }

  const currentUsed = foundAction.limitedUse.numberUsed;
  const maxUses = foundAction.limitedUse.maxUses;
  const newUses = params.uses ?? currentUsed + 1;

  if (newUses < 0 || newUses > maxUses) {
    return {
      content: [
        {
          type: "text",
          text: `Uses must be between 0 and ${maxUses}. Currently ${currentUsed}/${maxUses} used.`,
        },
      ],
    };
  }

  // D&D Beyond expects id and entityTypeId as strings, characterId in the body
  await client.put(
    ENDPOINTS.character.updateLimitedUse(),
    {
      characterId: params.characterId,
      id: String(foundAction.id),
      entityTypeId: String(foundAction.entityTypeId),
      uses: newUses,
    },
    [`character:${params.characterId}`]
  );

  return {
    content: [
      {
        type: "text",
        text: `${foundAction.name}: ${newUses}/${maxUses} uses expended.`,
      },
    ],
  };
}

// ============================================================================
// CHARACTER CREATION / BUILDER
// ============================================================================

interface CreateCharacterParams {
  method: "standard" | "quick";
  classId?: number;
  entityRaceId?: number;
  entityRaceTypeId?: number;
}

export async function createCharacter(
  client: DdbClient,
  params: CreateCharacterParams
): Promise<ToolResult> {
  if (params.method === "quick") {
    if (!params.classId || !params.entityRaceId || !params.entityRaceTypeId) {
      return { content: [{ type: "text", text: "Quick build requires classId, entityRaceId, and entityRaceTypeId." }] };
    }
    const characterId = await client.post<number>(
      ENDPOINTS.character.builder.quickBuild(),
      { classId: params.classId, entityRaceId: params.entityRaceId, entityRaceTypeId: params.entityRaceTypeId }
    );
    return { content: [{ type: "text", text: `Created character via quick build. Character ID: ${characterId}` }] };
  }

  const characterId = await client.post<number>(
    ENDPOINTS.character.builder.standardBuild(),
    { showHelpText: false }
  );
  return { content: [{ type: "text", text: `Created character via standard build. Character ID: ${characterId}` }] };
}

interface DeleteCharacterParams {
  characterId: number;
}

export async function deleteCharacter(
  client: DdbClient,
  params: DeleteCharacterParams
): Promise<ToolResult> {
  await client.delete(
    ENDPOINTS.character.delete(),
    { characterId: params.characterId },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Deleted character ${params.characterId}.` }] };
}

interface AddClassParams {
  characterId: number;
  classId: number;
  level: number;
}

export async function addClass(
  client: DdbClient,
  params: AddClassParams
): Promise<ToolResult> {
  await client.post(
    ENDPOINTS.character.addClass(),
    { characterId: params.characterId, classId: params.classId, level: params.level },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Added class ${params.classId} at level ${params.level} to character ${params.characterId}.` }] };
}

interface SetBackgroundParams {
  characterId: number;
  backgroundId: number;
}

export async function setBackground(
  client: DdbClient,
  params: SetBackgroundParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setBackground(),
    { characterId: params.characterId, backgroundId: params.backgroundId },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set background ${params.backgroundId} on character ${params.characterId}.` }] };
}

interface SetBackgroundChoiceParams {
  characterId: number;
  type: number;
  choiceKey: string;
  choiceValue: number;
}

export async function setBackgroundChoice(
  client: DdbClient,
  params: SetBackgroundChoiceParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setBackgroundChoice(),
    { characterId: params.characterId, type: params.type, choiceKey: params.choiceKey, choiceValue: params.choiceValue },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set background choice on character ${params.characterId}.` }] };
}

interface SetSpeciesParams {
  characterId: number;
  entityRaceId: number;
  entityRaceTypeId: number;
}

export async function setSpecies(
  client: DdbClient,
  params: SetSpeciesParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setRace(),
    { characterId: params.characterId, entityRaceId: params.entityRaceId, entityRaceTypeId: params.entityRaceTypeId },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set species on character ${params.characterId}.` }] };
}

interface SetAbilityScoreParams {
  characterId: number;
  statId: number;
  type: number;
  value: number;
}

export async function setAbilityScore(
  client: DdbClient,
  params: SetAbilityScoreParams
): Promise<ToolResult> {
  if (params.statId < 1 || params.statId > 6) {
    return { content: [{ type: "text", text: "statId must be between 1 (STR) and 6 (CHA)." }] };
  }
  const abilityName = ["STR", "DEX", "CON", "INT", "WIS", "CHA"][params.statId - 1];
  await client.put(
    ENDPOINTS.character.setAbilityScore(),
    { characterId: params.characterId, statId: params.statId, type: params.type, value: params.value },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set ${abilityName} to ${params.value} on character ${params.characterId}.` }] };
}

interface UpdateCharacterNameParams {
  characterId: number;
  name: string;
}

export async function updateCharacterName(
  client: DdbClient,
  params: UpdateCharacterNameParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.updateName(),
    { characterId: params.characterId, name: params.name },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Updated character ${params.characterId} name to "${params.name}".` }] };
}

// ============================================================================
// CLASS LEVEL & ABILITY SCORE TYPE
// ============================================================================

interface SetClassLevelParams {
  characterId: number;
  classId: number;
  classMappingId: number;
  level: number;
}

export async function setClassLevel(
  client: DdbClient,
  params: SetClassLevelParams
): Promise<ToolResult> {
  if (params.level < 1 || params.level > 20) {
    return { content: [{ type: "text", text: "Level must be between 1 and 20." }] };
  }
  await client.put(
    ENDPOINTS.character.setClassLevel(),
    { characterId: params.characterId, classId: params.classId, classMappingId: params.classMappingId, level: params.level },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set class level to ${params.level} on character ${params.characterId}.` }] };
}

interface SetAbilityScoreTypeParams {
  characterId: number;
  abilityScoreType: number;
}

export async function setAbilityScoreType(
  client: DdbClient,
  params: SetAbilityScoreTypeParams
): Promise<ToolResult> {
  const typeNames: Record<number, string> = { 1: "Standard Array", 2: "Rolled", 3: "Point Buy" };
  const typeName = typeNames[params.abilityScoreType] ?? `type ${params.abilityScoreType}`;
  await client.put(
    ENDPOINTS.character.setAbilityScoreType(),
    { characterId: params.characterId, abilityScoreType: params.abilityScoreType },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set ability score method to ${typeName} on character ${params.characterId}.` }] };
}

// ============================================================================
// INVENTORY / STARTING EQUIPMENT
// ============================================================================

interface SetStartingEquipmentTypeParams {
  characterId: number;
  startingEquipmentType: number;
}

export async function setStartingEquipmentType(
  client: DdbClient,
  params: SetStartingEquipmentTypeParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.inventory.setStartingType(),
    { characterId: params.characterId, startingEquipmentType: params.startingEquipmentType },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set starting equipment type to ${params.startingEquipmentType} on character ${params.characterId}.` }] };
}

interface AddInventoryItemsParams {
  characterId: number;
  equipment: Array<{
    entityId: number;
    entityTypeId: number;
    quantity: number;
  }>;
}

export async function addInventoryItems(
  client: DdbClient,
  params: AddInventoryItemsParams
): Promise<ToolResult> {
  const items = params.equipment.map(item => ({
    containerEntityId: params.characterId,
    containerEntityTypeId: 1581111423, // Character container type
    entityId: item.entityId,
    entityTypeId: item.entityTypeId,
    quantity: item.quantity,
    originEntityId: null,
    originEntityTypeId: null,
  }));
  await client.post(
    ENDPOINTS.character.inventory.addItems(),
    { characterId: params.characterId, equipment: items },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Added ${params.equipment.length} item(s) to character ${params.characterId}.` }] };
}

interface RemoveInventoryItemParams {
  characterId: number;
  itemId: number;
}

/**
 * Remove an item from a character's inventory by its inventory ENTRY id (the
 * `id` on each entry in the inventory array, from get_character — NOT the item
 * definition id). Reads fresh first to validate the entry and name the result.
 */
export async function removeInventoryItem(
  client: DdbClient,
  params: RemoveInventoryItemParams
): Promise<ToolResult> {
  client.invalidateCache(`character:${params.characterId}`);
  const character = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `character:${params.characterId}`,
    60_000
  );
  const entry = (character.inventory ?? []).find((i) => i.id === params.itemId);
  if (!entry) {
    return { content: [{ type: "text", text: `No inventory item with entry id ${params.itemId} on character ${params.characterId}.` }] };
  }

  await client.delete(
    ENDPOINTS.character.inventory.removeItem(),
    { characterId: params.characterId, id: params.itemId },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Removed "${entry.definition?.name ?? "item"}" (entry ${params.itemId}) from character ${params.characterId}.` }] };
}

interface SetGoldParams {
  characterId: number;
  amount: number;
}

export async function setGold(
  client: DdbClient,
  params: SetGoldParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.inventory.setGold(),
    { characterId: params.characterId, amount: params.amount },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set gold to ${params.amount} on character ${params.characterId}.` }] };
}

interface SetMaxHpParams {
  characterId: number;
  maxHp: number;
}

/**
 * Override a character's maximum hit points to a fixed value.
 * Useful for fixed / manually-entered HP totals (e.g. imported characters or
 * house-rule HP). update_hp only applies damage/healing; this sets the maximum.
 */
export async function setMaxHp(
  client: DdbClient,
  params: SetMaxHpParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setMaxHp(),
    { characterId: params.characterId, overrideHitPoints: params.maxHp },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set max HP override to ${params.maxHp} on character ${params.characterId}.` }] };
}

interface SetXpParams {
  characterId: number;
  xp: number;
}

/**
 * Set a character's experience points to an absolute value. Note: XP only drives
 * leveling when the character's progression type is "XP" (preferences.progressionType
 * = 2); on Milestone (1) the value is stored but ignored for leveling.
 */
export async function setXp(
  client: DdbClient,
  params: SetXpParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setXp(),
    { characterId: params.characterId, currentXp: params.xp },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set XP to ${params.xp} on character ${params.characterId}.` }] };
}

interface SetItemEquippedParams {
  characterId: number;
  inventoryItemId: number;
  equipped?: boolean;
}

/**
 * Equip or unequip an inventory item by its inventory entry id (the `id` on each
 * entry in the character's inventory array, NOT the item definition id). A weapon
 * only appears as an attack action once it is equipped; add_inventory_items adds
 * items unequipped.
 */
export async function setItemEquipped(
  client: DdbClient,
  params: SetItemEquippedParams
): Promise<ToolResult> {
  const equipped = params.equipped ?? true;
  await client.put(
    ENDPOINTS.character.inventory.equipped(),
    { characterId: params.characterId, id: params.inventoryItemId, value: equipped },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `${equipped ? "Equipped" : "Unequipped"} inventory item ${params.inventoryItemId} on character ${params.characterId}.` }] };
}

const CUSTOM_PROFICIENCY_TYPES: Record<number, string> = { 1: "skill", 2: "tool", 3: "language" };

interface AddCustomProficiencyParams {
  characterId: number;
  name: string;
  type: number; // 1 = skill, 2 = tool, 3 = language
  proficiencyLevel?: number; // 1 = half, 2 = proficient, 3 = expertise (default 2)
}

/**
 * Add a custom proficiency (skill, tool, or language) — D&D Beyond's
 * "Manage Custom Proficiencies" feature. Useful for proficiencies that aren't
 * available as standard builder choices (e.g. a custom background's tool, or a
 * rare language like Undercommon).
 */
export async function addCustomProficiency(
  client: DdbClient,
  params: AddCustomProficiencyParams
): Promise<ToolResult> {
  await client.post(
    ENDPOINTS.character.customProficiency(),
    {
      characterId: params.characterId,
      name: params.name,
      type: params.type,
      proficiencyLevel: params.proficiencyLevel ?? 2,
    },
    [`character:${params.characterId}`]
  );
  const kind = CUSTOM_PROFICIENCY_TYPES[params.type] ?? "proficiency";
  return { content: [{ type: "text", text: `Added custom ${kind} proficiency "${params.name}" to character ${params.characterId}.` }] };
}

interface AddCustomItemParams {
  characterId: number;
  name: string;
  description?: string;
  quantity?: number;
}

/**
 * Add a custom (homebrew) item to a character's inventory — for items with no
 * D&D Beyond definition (e.g. house-rule potions, quest items like a sealed
 * casket). For items that DO have a definition, use add_inventory_items instead.
 */
export async function addCustomItem(
  client: DdbClient,
  params: AddCustomItemParams
): Promise<ToolResult> {
  await client.post(
    ENDPOINTS.character.inventory.customItem(),
    {
      characterId: params.characterId,
      name: params.name,
      description: params.description ?? "",
      quantity: params.quantity ?? 1,
    },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Added custom item "${params.name}" (x${params.quantity ?? 1}) to character ${params.characterId}.` }] };
}

// D&D Beyond's entityTypeId for the shared party-inventory container.
const PARTY_CONTAINER_ENTITY_TYPE_ID = 618115330;

interface AddPartyInventoryItemParams {
  campaignId: number;
  characterId: number;
  name: string;
  description?: string;
  notes?: string;
  quantity?: number;
  weight?: number;
  cost?: number;
}

export async function addPartyInventoryItem(
  client: DdbClient,
  params: AddPartyInventoryItemParams
): Promise<ToolResult> {
  const quantity = params.quantity ?? 1;
  // Same custom-item endpoint as for characters, but the container fields route the
  // item into the campaign-wide party inventory instead of the character's own pack.
  // characterId is the acting member; container/partyId point at the campaign.
  await client.post(
    ENDPOINTS.character.inventory.partyCustomItem(),
    {
      characterId: params.characterId,
      name: params.name,
      description: params.description ?? "",
      notes: params.notes ?? "",
      quantity,
      weight: params.weight ?? null,
      cost: params.cost ?? null,
      containerEntityId: params.campaignId,
      containerEntityTypeId: PARTY_CONTAINER_ENTITY_TYPE_ID,
      partyId: params.campaignId,
    },
    [`campaign:${params.campaignId}:party-inventory`]
  );
  return {
    content: [
      {
        type: "text",
        text: `Added "${params.name}" (x${quantity}) to the party inventory of campaign ${params.campaignId}.`,
      },
    ],
  };
}

interface RemovePartyInventoryItemParams {
  campaignId: number;
  characterId: number;
  itemId: number; // party-inventory entry id (partyItems[].id, shown by get_campaign_characters)
}

export async function removePartyInventoryItem(
  client: DdbClient,
  params: RemovePartyInventoryItemParams
): Promise<ToolResult> {
  const cacheKey = `campaign:${params.campaignId}:party-inventory`;
  // Re-read fresh: the entry's definition id is required for the delete, and the
  // shared inventory may have changed since it was last cached.
  client.invalidateCache(cacheKey);
  const inventory = await client.get<DdbPartyInventory>(
    ENDPOINTS.campaign.partyInventory(params.campaignId),
    cacheKey,
    5 * 60 * 1000
  );

  const entry = (inventory?.partyItems ?? []).find((i) => i.id === params.itemId);
  if (!entry) {
    return {
      content: [{ type: "text", text: `No party-inventory item with id ${params.itemId} in campaign ${params.campaignId}.` }],
    };
  }
  const definitionId = entry.definition?.id;
  if (definitionId == null) {
    return {
      content: [{ type: "text", text: `Item "${entry.definition.name}" (${params.itemId}) has no custom-item definition id and cannot be removed this way.` }],
    };
  }

  await client.delete(
    ENDPOINTS.character.inventory.partyCustomItem(),
    {
      characterId: params.characterId,
      id: definitionId,
      mappingId: params.itemId,
      partyId: params.campaignId,
    },
    [cacheKey]
  );
  return {
    content: [{ type: "text", text: `Removed "${entry.definition.name}" from the party inventory of campaign ${params.campaignId}.` }],
  };
}

interface UpdatePartyInventoryItemParams {
  campaignId: number;
  characterId: number;
  itemId: number; // party-inventory entry id (partyItems[].id)
  name?: string;
  weight?: number;
  cost?: number;
  quantity?: number;
  description?: string;
  notes?: string;
}

export async function updatePartyInventoryItem(
  client: DdbClient,
  params: UpdatePartyInventoryItemParams
): Promise<ToolResult> {
  const cacheKey = `campaign:${params.campaignId}:party-inventory`;
  // Re-read fresh: PUT replaces the whole item, so unspecified fields must be
  // merged from the current state (which may have changed since last cached).
  client.invalidateCache(cacheKey);
  const inventory = await client.get<DdbPartyInventory>(
    ENDPOINTS.campaign.partyInventory(params.campaignId),
    cacheKey,
    5 * 60 * 1000
  );

  const entry = (inventory?.partyItems ?? []).find((i) => i.id === params.itemId);
  if (!entry) {
    return { content: [{ type: "text", text: `No party-inventory item with id ${params.itemId} in campaign ${params.campaignId}.` }] };
  }
  const def = entry.definition;
  if (def.id == null) {
    return { content: [{ type: "text", text: `Item "${def.name}" (${params.itemId}) has no custom-item definition id and cannot be edited this way.` }] };
  }

  // Merge provided changes over current values. `notes` is NOT returned by the
  // read endpoint, so it defaults to empty unless the caller supplies it.
  await client.put(
    ENDPOINTS.character.inventory.partyCustomItem(),
    {
      characterId: params.characterId,
      id: def.id,
      mappingId: params.itemId,
      partyId: params.campaignId,
      name: params.name ?? def.name,
      weight: params.weight ?? def.weight ?? null,
      cost: params.cost ?? def.cost ?? null,
      quantity: params.quantity ?? entry.quantity,
      description: params.description ?? def.description ?? "",
      notes: params.notes ?? "",
    },
    [cacheKey]
  );
  return {
    content: [{ type: "text", text: `Updated "${params.name ?? def.name}" in the party inventory of campaign ${params.campaignId}.` }],
  };
}

// ============================================================================
// DESCRIPTION FIELDS
// ============================================================================

interface UpdateDescriptionParams {
  characterId: number;
  field: string;
  value: string | number;
}

export async function updateDescription(
  client: DdbClient,
  params: UpdateDescriptionParams
): Promise<ToolResult> {
  const FIELD_ENDPOINTS: Record<string, { endpoint: () => string; bodyKey: string }> = {
    alignment: { endpoint: ENDPOINTS.character.updateAlignment, bodyKey: "alignmentId" },
    lifestyle: { endpoint: ENDPOINTS.character.updateLifestyle, bodyKey: "lifestyleId" },
    faith: { endpoint: ENDPOINTS.character.updateFaith, bodyKey: "faith" },
    hair: { endpoint: () => ENDPOINTS.character.updateAppearance("hair"), bodyKey: "hair" },
    skin: { endpoint: () => ENDPOINTS.character.updateAppearance("skin"), bodyKey: "skin" },
    eyes: { endpoint: () => ENDPOINTS.character.updateAppearance("eyes"), bodyKey: "eyes" },
    height: { endpoint: () => ENDPOINTS.character.updateAppearance("height"), bodyKey: "height" },
    weight: { endpoint: () => ENDPOINTS.character.updateAppearance("weight"), bodyKey: "weight" },
    age: { endpoint: () => ENDPOINTS.character.updateAppearance("age"), bodyKey: "age" },
    gender: { endpoint: () => ENDPOINTS.character.updateAppearance("gender"), bodyKey: "gender" },
    personalityTraits: { endpoint: ENDPOINTS.character.updateTraits, bodyKey: "personalityTraits" },
    ideals: { endpoint: ENDPOINTS.character.updateTraits, bodyKey: "ideals" },
    bonds: { endpoint: ENDPOINTS.character.updateTraits, bodyKey: "bonds" },
    flaws: { endpoint: ENDPOINTS.character.updateTraits, bodyKey: "flaws" },
    backstory: { endpoint: ENDPOINTS.character.updateNotes, bodyKey: "backstory" },
    otherNotes: { endpoint: ENDPOINTS.character.updateNotes, bodyKey: "otherNotes" },
    allies: { endpoint: ENDPOINTS.character.updateNotes, bodyKey: "allies" },
    organizations: { endpoint: ENDPOINTS.character.updateNotes, bodyKey: "organizations" },
    enemies: { endpoint: ENDPOINTS.character.updateNotes, bodyKey: "enemies" },
  };

  const config = FIELD_ENDPOINTS[params.field];
  if (!config) {
    const validFields = Object.keys(FIELD_ENDPOINTS).join(", ");
    return { content: [{ type: "text", text: `Invalid field "${params.field}". Valid fields: ${validFields}` }] };
  }

  await client.put(
    config.endpoint(),
    { characterId: params.characterId, [config.bodyKey]: params.value },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Updated ${params.field} on character ${params.characterId}.` }] };
}

// ============================================================================
// CHOICE RESOLUTION
// ============================================================================

interface SetClassFeatureChoiceParams {
  characterId: number;
  classId: number;
  classFeatureId: number;
  classMappingId: number;
  type: number;
  choiceKey: string;
  choiceValue: number;
  parentChoiceId?: number | null;
}

export async function setClassFeatureChoice(
  client: DdbClient,
  params: SetClassFeatureChoiceParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setClassFeatureChoice(),
    {
      characterId: params.characterId,
      classId: params.classId,
      classFeatureId: params.classFeatureId,
      classMappingId: params.classMappingId,
      type: params.type,
      choiceKey: params.choiceKey,
      choiceValue: params.choiceValue,
      parentChoiceId: params.parentChoiceId ?? null,
    },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set class feature choice on character ${params.characterId}.` }] };
}

interface SetRaceTraitChoiceParams {
  characterId: number;
  racialTraitId: number;
  type: number;
  choiceKey: string;
  choiceValue: number;
}

export async function setRaceTraitChoice(
  client: DdbClient,
  params: SetRaceTraitChoiceParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setRaceTraitChoice(),
    {
      characterId: params.characterId,
      racialTraitId: params.racialTraitId,
      type: params.type,
      choiceKey: params.choiceKey,
      choiceValue: params.choiceValue,
    },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set race trait choice on character ${params.characterId}.` }] };
}

interface SetFeatChoiceParams {
  characterId: number;
  featId: number;
  type: number;
  choiceKey: string;
  choiceValue: number;
}

export async function setFeatChoice(
  client: DdbClient,
  params: SetFeatChoiceParams
): Promise<ToolResult> {
  await client.put(
    ENDPOINTS.character.setFeatChoice(),
    {
      characterId: params.characterId,
      id: params.featId,
      type: params.type,
      choiceKey: params.choiceKey,
      choiceValue: params.choiceValue,
    },
    [`character:${params.characterId}`]
  );
  return { content: [{ type: "text", text: `Set feat choice on character ${params.characterId}.` }] };
}

interface ResolveChoicesParams {
  characterId: number;
}

export async function resolveChoices(
  client: DdbClient,
  params: ResolveChoicesParams
): Promise<ToolResult> {
  const MAX_ITERATIONS = 8;
  const resolved: string[] = [];
  const skipped: string[] = [];
  const configFixed: string[] = [];

  // First, fix missing configuration fields
  const initialChar = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `resolve-init:${params.characterId}:${Date.now()}`,
    1
  );
  const config = (initialChar as any).configuration ?? {};

  if (!config.abilityScoreType) {
    try {
      await client.put(
        ENDPOINTS.character.setAbilityScoreType(),
        { characterId: params.characterId, abilityScoreType: 1 },
        [`character:${params.characterId}`]
      );
      configFixed.push("abilityScoreType → Standard Array");
    } catch { /* ignore */ }
  }

  if (!config.startingEquipmentType) {
    try {
      await client.put(
        ENDPOINTS.character.inventory.setStartingType(),
        { characterId: params.characterId, startingEquipmentType: 1 },
        [`character:${params.characterId}`]
      );
      configFixed.push("startingEquipmentType → Normal");
    } catch { /* ignore */ }
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const char = await client.get<DdbCharacter>(
      ENDPOINTS.character.get(params.characterId),
      `resolve:${params.characterId}:${Date.now()}`,
      1 // no cache
    );

    // Build choiceDefinitions lookup
    const choiceDefs = (char as any).choices?.choiceDefinitions ?? [];
    const defMap = new Map<string, any[]>();
    for (const cd of choiceDefs) {
      if (cd.options?.length) defMap.set(cd.id, cd.options);
    }

    // Gather unresolved choices
    const choices = (char as any).choices ?? {};
    const unresolved: Array<{ category: string; choice: any }> = [];
    for (const [key, val] of Object.entries(choices)) {
      if (key === "choiceDefinitions") continue;
      const arr = val as any[];
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (!c.optionValue) unresolved.push({ category: key, choice: c });
      }
    }

    if (unresolved.length === 0) break;

    let progressMade = false;
    const charClass = char.classes?.[0];
    const classId = charClass?.definition?.id;
    const classMappingId = charClass?.id;

    for (const { category, choice } of unresolved) {
      // Find option ID from optionIds or choiceDefinitions
      let optionId: number | null = null;
      if (choice.optionIds?.length > 0) {
        optionId = choice.optionIds[0];
      } else {
        const defKey = `${choice.componentTypeId}-${choice.type}`;
        const options = defMap.get(defKey);
        if (options?.length) {
          // Prefer default if specified
          if (choice.defaultSubtypes?.length > 0) {
            const match = options.find((o: any) => o.label === choice.defaultSubtypes[0]);
            optionId = match?.id ?? options[0].id;
          } else {
            optionId = options[0].id;
          }
        }
      }

      if (!optionId) {
        skipped.push(`${category}:${choice.id}`);
        continue;
      }

      try {
        switch (category) {
          case "background":
            await client.put(ENDPOINTS.character.setBackgroundChoice(), {
              characterId: params.characterId, type: choice.type,
              choiceKey: choice.id, choiceValue: optionId,
            }, [`character:${params.characterId}`]);
            break;
          case "class":
            await client.put(ENDPOINTS.character.setClassFeatureChoice(), {
              characterId: params.characterId, classId, type: choice.type,
              choiceKey: choice.id, choiceValue: optionId,
              classFeatureId: choice.componentId, classMappingId,
            }, [`character:${params.characterId}`]);
            break;
          case "race":
            await client.put(ENDPOINTS.character.setRaceTraitChoice(), {
              characterId: params.characterId, type: choice.type,
              choiceKey: choice.id, choiceValue: optionId,
              racialTraitId: choice.componentId,
            }, [`character:${params.characterId}`]);
            break;
          case "feat":
            await client.put(ENDPOINTS.character.setFeatChoice(), {
              characterId: params.characterId, id: choice.componentId,
              type: choice.type, choiceKey: choice.id, choiceValue: optionId,
            }, [`character:${params.characterId}`]);
            break;
          default:
            skipped.push(`${category}:${choice.id}`);
            continue;
        }
        resolved.push(`${category}: ${choice.label || choice.id}`);
        progressMade = true;
      } catch {
        skipped.push(`${category}:${choice.id}`);
      }
    }

    if (!progressMade) break;
  }

  // Final count
  const finalChar = await client.get<DdbCharacter>(
    ENDPOINTS.character.get(params.characterId),
    `resolve-final:${params.characterId}:${Date.now()}`,
    1
  );
  const finalChoices = (finalChar as any).choices ?? {};
  let remaining = 0;
  for (const [key, val] of Object.entries(finalChoices)) {
    if (key === "choiceDefinitions") continue;
    const arr = val as any[];
    if (!Array.isArray(arr)) continue;
    remaining += arr.filter((c: any) => !c.optionValue).length;
  }

  const lines = [
    `Auto-resolved ${resolved.length} choices on ${finalChar.name}.`,
    ...(configFixed.length > 0 ? [`Configuration set: ${configFixed.join(", ")}`] : []),
    ...(resolved.length > 0 ? [`Resolved: ${resolved.join(", ")}`] : []),
    ...(skipped.length > 0 ? [`Skipped (no options): ${skipped.length}`] : []),
    ...(remaining > 0 ? [`Remaining unresolved: ${remaining}`] : ["All choices resolved."]),
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
