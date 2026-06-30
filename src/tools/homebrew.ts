import type { DdbClient } from "../api/client.js";
import { HomebrewClient, type ModifierFields, type HomebrewItemRef } from "../api/homebrew.js";
import { MODIFIER_TYPES, MODIFIER_SUBTYPES, MODIFIER_TYPE_NAMES } from "../data/homebrew-modifiers.js";
import { ENDPOINTS } from "../api/endpoints.js";
import { addInventoryItems } from "./character.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// entityTypeId of the shared party-inventory container (see character.ts). A real
// homebrew item (definition + modifiers) can be dropped here just like onto a
// character; the modifiers travel with it and apply once a character equips it.
const PARTY_CONTAINER_ENTITY_TYPE_ID = 618115330;

/**
 * Add an already-created item to a campaign's shared party inventory. The acting
 * character must be a member of the campaign; if none is given we use the first
 * roster member.
 */
async function addToPartyInventory(
  client: DdbClient,
  campaignId: number,
  actingCharacterId: number | undefined,
  ref: HomebrewItemRef,
): Promise<void> {
  let actor = actingCharacterId;
  if (actor == null) {
    const members = await client.get<Array<{ id: number }>>(
      ENDPOINTS.campaign.characters(campaignId),
      `campaign:${campaignId}:members`,
      60_000,
    );
    actor = members?.[0]?.id;
    if (actor == null) {
      throw new Error(`No roster member found in campaign ${campaignId} to act as the owner.`);
    }
  }
  await client.post(
    ENDPOINTS.character.inventory.addItems(),
    {
      characterId: actor,
      equipment: [
        {
          containerEntityId: campaignId,
          containerEntityTypeId: PARTY_CONTAINER_ENTITY_TYPE_ID,
          entityId: ref.itemId,
          entityTypeId: ref.entityTypeId,
          quantity: 1,
          originEntityId: null,
          originEntityTypeId: null,
        },
      ],
    },
    [`campaign:${campaignId}:party-inventory`],
  );
}

// Charge reset-condition name -> id (from the builder's charge-reset-condition <select>).
const CHARGE_RESET_IDS: Record<string, number> = {
  "short rest": 1,
  "long rest": 2,
  dawn: 3,
  consumable: 4,
  other: 5,
};

// Rarity name -> D&D Beyond rarity id (from the builder's rarity <select>).
const RARITY_IDS: Record<string, number> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  "very rare": 4,
  legendary: 5,
  artifact: 7,
  varies: 9,
};

// Clean, equippable base items with NO granted modifiers — copying one of these
// means nothing has to be stripped before adding our own modifiers. (verified live
// against game-data/items: canEquip, no grantedModifiers, no attunement.)
//   typeId is the builder's magic-item-type select value.
const CLEAN_BASES: Record<string, { typeId: number; baseItemId: number; label: string }> = {
  amulet: { typeId: 10, baseItemId: 27042, label: "Clockwork Amulet (neck)" },
  necklace: { typeId: 10, baseItemId: 27042, label: "Clockwork Amulet (neck)" },
  wondrous: { typeId: 10, baseItemId: 27042, label: "Clockwork Amulet (wondrous)" },
};

export interface HomebrewModifierSpec {
  /** Modifier type, e.g. "bonus", "advantage", "set", "resistance". */
  type: string;
  /** Modifier subtype, e.g. "initiative", "armor class", "strength-score". */
  subType?: string;
  /** Flat numeric value (for "bonus"/"set"). */
  value?: number;
  /** Dice expression like "1d4" (for dice-based bonuses/damage). */
  dice?: string;
  /** Free-text restriction note shown on the modifier. */
  restriction?: string;
  /** Whether THIS modifier only applies while the item is attuned. */
  requiresAttunement?: boolean;
}

export interface CreateHomebrewItemParams {
  name: string;
  rarity: string;
  modifiers?: HomebrewModifierSpec[];
  description?: string;
  /** Slot preset selecting a clean base item (default "amulet"). */
  slot?: string;
  /** Override the base item to copy (advanced; must be a clean equippable base). */
  baseItemId?: number;
  /** magic-item-type id for an explicit baseItemId (10 = Wondrous Item). */
  baseTypeId?: number;
  requiresAttunement?: boolean;
  attunementDescription?: string;
  weight?: number;
  notes?: string;
  /** Limited-use charges — renders a tickable counter on the sheet. */
  charges?: number;
  /** When charges reset: "short rest", "long rest", "dawn", "consumable", "other" (default "dawn"). */
  chargeReset?: string;
  /** If given, the finished item is also added to this character's inventory. */
  characterId?: number;
  /** If given, the finished item is also dropped into this campaign's party inventory. */
  campaignId?: number;
  /** Acting campaign member for the party drop (defaults to the first roster member). */
  actingCharacterId?: number;
}

export function resolveModifier(spec: HomebrewModifierSpec): { fields: ModifierFields; label: string } {
  const typeKey = spec.type.trim().toLowerCase();
  const typeId = MODIFIER_TYPES[typeKey];
  if (typeId == null) {
    throw new Error(
      `Unknown modifier type "${spec.type}". Valid types: ${Object.keys(MODIFIER_TYPES).join(", ")}.`,
    );
  }

  let subTypeId: number | undefined;
  let subLabel = "";
  if (spec.subType) {
    const wanted = spec.subType.trim().toLowerCase();
    // Prefer a subtype that belongs to the chosen type group; fall back to any name match.
    const inGroup = MODIFIER_SUBTYPES.filter(
      (s) => s.name.toLowerCase() === wanted && s.type === typeId,
    );
    const anyMatch = MODIFIER_SUBTYPES.filter((s) => s.name.toLowerCase() === wanted);
    const hit = inGroup[0] ?? anyMatch[0];
    if (!hit) {
      throw new Error(
        `Unknown modifier subtype "${spec.subType}" for type "${spec.type}". ` +
          `Examples for ${MODIFIER_TYPE_NAMES[typeId]}: ` +
          MODIFIER_SUBTYPES.filter((s) => s.type === typeId)
            .slice(0, 12)
            .map((s) => s.name)
            .join(", "),
      );
    }
    subTypeId = hit.id;
    subLabel = ` ${hit.name}`;
  }

  let diceCount: number | undefined;
  let diceValue: number | undefined;
  if (spec.dice) {
    const m = spec.dice.trim().toLowerCase().match(/^(\d+)d(\d+)$/);
    if (!m) throw new Error(`Invalid dice "${spec.dice}" — use e.g. "1d4".`);
    diceCount = Number(m[1]);
    diceValue = Number(m[2]);
  }

  const valueLabel =
    spec.value != null ? ` ${spec.value >= 0 ? "+" : ""}${spec.value}` : spec.dice ? ` ${spec.dice}` : "";
  return {
    fields: {
      typeId,
      subTypeId,
      fixedValue: spec.value,
      diceCount,
      diceValue,
      restriction: spec.restriction,
      requiresAttunement: spec.requiresAttunement,
    },
    label: `${MODIFIER_TYPE_NAMES[typeId]}${subLabel}${valueLabel}`,
  };
}

/**
 * Create a real, mechanically-effective homebrew magic item on D&D Beyond.
 *
 * Unlike add_custom_item (which produces a flavor-only entry that grants no stats),
 * this builds a homebrew item *definition* with grantedModifiers, so bonuses like
 * "+1 initiative" actually apply on the character sheet once the item is equipped.
 *
 * Note: D&D Beyond items cannot model "once-per-day" limited-use effects. Put such
 * wording in the description and track uses manually.
 */
export async function createHomebrewItem(
  client: DdbClient,
  params: CreateHomebrewItemParams,
): Promise<ToolResult> {
  const rarityKey = params.rarity.trim().toLowerCase();
  const rarityId = RARITY_IDS[rarityKey];
  if (rarityId == null) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown rarity "${params.rarity}". Valid: ${Object.keys(RARITY_IDS).join(", ")}.`,
        },
      ],
    };
  }

  // Pick the base item to copy.
  let typeId: number;
  let baseItemId: number;
  let baseLabel: string;
  if (params.baseItemId != null) {
    baseItemId = params.baseItemId;
    typeId = params.baseTypeId ?? 10;
    baseLabel = `base item ${baseItemId}`;
  } else {
    const preset = CLEAN_BASES[(params.slot ?? "amulet").trim().toLowerCase()];
    if (!preset) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown slot "${params.slot}". Known slots: ${Object.keys(CLEAN_BASES).join(", ")}. Or pass baseItemId.`,
          },
        ],
      };
    }
    typeId = preset.typeId;
    baseItemId = preset.baseItemId;
    baseLabel = preset.label;
  }

  // Resolve modifiers up front so a bad spec fails before we touch D&D Beyond.
  let resolved: Array<{ fields: ModifierFields; label: string }>;
  try {
    resolved = (params.modifiers ?? []).map(resolveModifier);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  // Resolve the charge reset condition (default Dawn for "once per day").
  let chargeResetId: number | undefined;
  if (params.charges != null && params.charges > 0) {
    const resetKey = (params.chargeReset ?? "dawn").trim().toLowerCase();
    chargeResetId = CHARGE_RESET_IDS[resetKey];
    if (chargeResetId == null) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown chargeReset "${params.chargeReset}". Valid: ${Object.keys(CHARGE_RESET_IDS).join(", ")}.`,
          },
        ],
      };
    }
  }

  const hb = new HomebrewClient();
  let ref: HomebrewItemRef;
  try {
    ref = await hb.createFromBase(typeId, baseItemId);
    ref = await hb.saveCoreFields(ref, {
      name: params.name,
      rarityId,
      description: params.description,
      requiresAttunement: params.requiresAttunement,
      attunementDescription: params.attunementDescription,
      weight: params.weight,
      notes: params.notes,
      charges: params.charges,
      chargeResetId,
    });
    for (const r of resolved) {
      await hb.addModifier(ref, r.fields);
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to create homebrew item "${params.name}": ${(err as Error).message}`,
        },
      ],
    };
  }

  const lines: string[] = [
    `Created homebrew magic item "${params.name}" (id ${ref.itemId}, ${params.rarity}${
      params.requiresAttunement ? ", requires attunement" : ""
    }).`,
    `Base copied: ${baseLabel}. entityTypeId ${ref.entityTypeId} (use with add_inventory_items).`,
  ];
  if (resolved.length) {
    lines.push("Modifiers:");
    for (const r of resolved) lines.push(`  • ${r.label}`);
  } else {
    lines.push("No modifiers added (flavor/description only).");
  }
  if (params.charges != null && params.charges > 0) {
    lines.push(
      `Charges: ${params.charges} (resets on ${params.chargeReset ?? "dawn"}) — shows as a tickable counter on the sheet.`,
    );
  }

  // Optionally drop it straight onto a character.
  if (params.characterId != null) {
    try {
      await addInventoryItems(client, {
        characterId: params.characterId,
        equipment: [{ entityId: ref.itemId, entityTypeId: ref.entityTypeId, quantity: 1 }],
      });
      lines.push(
        `Added to character ${params.characterId}. Equip it (equip_item) so the modifiers apply.`,
      );
    } catch (err) {
      lines.push(`(Could not auto-add to character ${params.characterId}: ${(err as Error).message})`);
    }
  }

  // Optionally drop it into the shared party inventory.
  if (params.campaignId != null) {
    try {
      await addToPartyInventory(client, params.campaignId, params.actingCharacterId, ref);
      lines.push(
        `Added to the party inventory of campaign ${params.campaignId}. Modifiers apply once a member takes and equips it.`,
      );
    } catch (err) {
      lines.push(`(Could not add to party inventory of campaign ${params.campaignId}: ${(err as Error).message})`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
