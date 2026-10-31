export interface DdbCharacter {
  id: number;
  readonlyUrl: string;
  name: string;
  race: DdbRace;
  classes: DdbClass[];
  background: DdbBackground;
  stats: DdbAbilityScore[];
  bonusStats: DdbAbilityScore[];
  overrideStats: DdbAbilityScore[];
  baseHitPoints: number;
  bonusHitPoints: number | null;
  overrideHitPoints: number | null;
  removedHitPoints: number;
  temporaryHitPoints: number;
  currentXp: number;
  alignmentId: number;
  lifestyleId: number;
  currencies: DdbCurrencies;
  spells: DdbSpellsContainer;
  inventory: DdbInventoryItem[];
  deathSaves: DdbDeathSaves;
  traits: DdbTraits;
  preferences: Record<string, unknown>;
  configuration: Record<string, unknown>;
  actions: Record<string, DdbAction[]>;
  modifiers: Record<string, DdbModifier[]>;
  campaign: { id: number; name: string } | null;
  // D&D Beyond's "Manage Custom Proficiencies" entries. These live OUTSIDE
  // modifiers, so anything scanning only modifiers silently misses them.
  customProficiencies?: DdbCustomProficiency[];
  feats: DdbFeat[];
  notes: DdbNotes;
  dateModified?: string;
  level?: number;
  pactMagic?: {
    level: number;
    used: number;
    available: number;
  } | null;
  spellSlots?: Array<{
    level: number;
    used: number;
    available: number;
  }>;
  hitDiceUsed?: number;
  // Spells each class has on its list (learned, or prepared from the full list).
  // Feat- and race-granted spells live in `spells` instead.
  classSpells?: Array<{ characterClassId: number; spells: DdbSpell[] }>;
}

export interface DdbRace {
  fullName: string;
  baseRaceName: string;
  isHomebrew: boolean;
  racialTraits: DdbRacialTrait[];
}

export interface DdbClass {
  // Mapping id of this class on the character — the key the short-rest write
  // expects in classHitDiceUsed, not the class definition id.
  id: number;
  definition: {
    id: number;
    name: string;
    canCastSpells?: boolean;
    // true: the whole class list is available and spells are only PREPARED
    // (Cleric, Druid). false: spells must be ADDED to the list first (Bard,
    // Paladin, Warlock, Wizard).
    knowsAllSpells?: boolean;
    spellPrepareType?: number | null;
    spellRules?: {
      levelCantripsKnownMaxes?: number[];
      levelSpellKnownMaxes?: number[];
      // Slots per spell level, indexed by class level: levelSpellSlots[15] = [4, 3, 3, 2, 0, ...].
      levelSpellSlots?: number[][];
      // Multiclass caster level = class level / divisor (1 full, 2 half, 3 third);
      // rounding 1 = down, 2 = up (the 2024 Paladin and Ranger round up).
      multiClassSpellSlotDivisor?: number | null;
      multiClassSpellSlotRounding?: number | null;
    } | null;
  };
  subclassDefinition: { name: string; classFeatures: DdbClassFeature[] } | null;
  level: number;
  isStartingClass: boolean;
  hitDiceUsed?: number;
  classFeatures: DdbClassFeature[];
}

export interface DdbBackground {
  definition: {
    name: string;
    description: string;
    featureName: string | null;
    featureDescription: string | null;
    snippet: string | null;
    skillProficienciesDescription: string | null;
    toolProficienciesDescription: string | null;
    equipmentDescription: string | null;
  } | null;
}

export interface DdbAbilityScore {
  id: number; // 1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA
  value: number | null;
}

export interface DdbCurrencies {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
}

export interface DdbSpellsContainer {
  race: DdbSpell[] | null;
  class: DdbSpell[] | null;
  background: DdbSpell[] | null;
  item: DdbSpell[] | null;
  feat: DdbSpell[] | null;
}

export interface DdbSpell {
  id: number;
  definition: {
    id?: number;
    name: string;
    level: number;
    school: string;
    description: string;
    range: {
      origin: string;
      rangeValue: number | null;
      aoeType: string | null;
      aoeValue: number | null;
    } | null;
    duration: {
      durationInterval: number | null;
      durationUnit: string | null; // "Hour", "Minute", etc.
      durationType: string; // "Concentration" or "Time"
    } | null;
    activation: {
      activationTime: number;
      activationType: number; // 1=Action, 3=Bonus Action, 6=Reaction
    } | null;
    components: number[] | null; // 1=V, 2=S, 3=M
    componentsDescription: string | null;
    concentration: boolean;
    ritual: boolean;
  };
  prepared: boolean;
  alwaysPrepared: boolean;
  usesSpellSlot: boolean;
  // Spell-list mapping fields. The spell write endpoints key a spell by
  // definition id + this mapping id + entityTypeId.
  entityTypeId?: number;
  definitionId?: number;
  countsAsKnownSpell?: boolean;
  // Optional fields present in the live character-service payload, used to
  // annotate a spell's granting source and its casting mode.
  componentId?: number;
  componentTypeId?: number;
  spellCastingAbilityId?: number | null;
  limitedUse?: {
    maxUses?: number | null;
    resetType?: number | null; // 1=short rest, 2=long rest, 3=day, 4=recharge
    numberUsed?: number | null;
    useProficiencyBonus?: boolean;
    statModifierUsesId?: number | null;
  } | null;
}

export interface DdbInventoryItem {
  id: number;
  definition: {
    // Present on custom items; the write endpoint takes THIS id, not the entry id.
    id?: number;
    name: string;
    description: string;
    type: string;
    rarity: string;
    weight: number;
    cost: number | null;
    isHomebrew: boolean;
    isCustomItem?: boolean;
    armorClass?: number | null;
    filterType?: string;
    armorTypeId?: number | null; // 1=light, 2=medium, 3=heavy, 4=shield
  };
  equipped: boolean;
  quantity: number;
}

export interface DdbDeathSaves {
  failCount: number | null;
  successCount: number | null;
  isStabilized: boolean;
}

export interface DdbTraits {
  personalityTraits: string | null;
  ideals: string | null;
  bonds: string | null;
  flaws: string | null;
  appearance: string | null;
}

export interface DdbCustomProficiency {
  id: number;
  name: string;
  type: number; // 1 = skill, 2 = tool, 3 = language
  proficiencyLevel: number; // 1 = half, 2 = proficient, 3 = expertise
}

export interface DdbLimitedUse {
  // Base charge count. When useProficiencyBonus is set, this is only the base —
  // the real cap is maxUses + proficiency bonus (Stonecunning ships as maxUses 0).
  maxUses: number;
  numberUsed: number;
  // 1 = Short Rest, 2 = Long Rest, 3 = Day. Verified 2026-07-25: Stonecunning
  // and Rage both read "regain uses on a Long Rest" and both carry resetType 2,
  // and a successful short rest left a resetType-2 resource untouched.
  resetType: number;
  resetTypeDescription: string;
  useProficiencyBonus?: boolean;
  proficiencyBonusOperator?: number; // 1 = add (the only value observed so far)
  // Ability id (1=STR..6=CHA) whose modifier sets the cap, e.g. Bardic Inspiration = 6.
  statModifierUsesId?: number | null;
}

export interface DdbAction {
  id: number;
  entityTypeId: number;
  name: string;
  componentId: number;
  componentTypeId: number;
  limitedUse: DdbLimitedUse | null;
}

export interface DdbModifier {
  id: string | number;
  type: string;
  subType: string;
  value: number | null;
  friendlyTypeName: string;
  friendlySubtypeName: string;
  componentId: number;
  componentTypeId: number;
}

export interface DdbFeat {
  definition: {
    id?: number;
    name: string;
    description: string;
    snippet: string | null;
    prerequisite: string | null;
  };
  componentId: number;
  componentTypeId: number;
}

export interface DdbClassFeature {
  // Class features nest under .definition; subclass features are flat
  definition?: {
    name: string;
    requiredLevel: number;
    description: string;
    snippet: string | null;
  };
  // Flat fields (subclass features)
  name?: string;
  requiredLevel?: number;
  description?: string;
}

export interface DdbRacialTrait {
  definition: {
    name: string;
    description: string;
    snippet: string | null;
  };
}

export interface DdbNotes {
  personalPossessions: string | null;
  backstory: string | null;
  otherNotes: string | null;
  allies: string | null;
  organizations: string | null;
}

export interface CharacterSummary {
  id: number;
  name: string;
  race: string;
  classes: string;
  level: number;
  hp: { current: number; max: number; temp: number };
  ac: number;
  campaignName: string | null;
}
