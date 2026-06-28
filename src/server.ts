import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TtlCache } from "./cache/lru.js";
import { CircuitBreaker, RateLimiter } from "./resilience/index.js";
import { DdbClient } from "./api/client.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerCharacterResources } from "./resources/character.js";
import { registerCampaignResources } from "./resources/campaign.js";
import { setupAuth, checkAuth } from "./tools/auth.js";
import {
  getCharacter,
  getCharacterChoices,
  getDefinition,
  listCharacters,
  updateHp,
  updateSpellSlots,
  updateDeathSaves,
  updateCurrency,
  updatePactMagic,
  longRest,
  shortRest,
  castSpell,
  useAbility,
  createCharacter,
  deleteCharacter,
  addClass,
  setBackground,
  setBackgroundChoice,
  setClassFeatureChoice,
  setRaceTraitChoice,
  setFeatChoice,
  resolveChoices,
  setInspiration,
  addCondition,
  removeCondition,
  setSpecies,
  setAbilityScore,
  updateCharacterName,
  setClassLevel,
  setAbilityScoreType,
  setStartingEquipmentType,
  addInventoryItems,
  setItemEquipped,
  setGold,
  setMaxHp,
  addCustomProficiency,
  addCustomItem,
  addPartyInventoryItem,
  removePartyInventoryItem,
  updateDescription,
} from "./tools/character.js";
import { listCampaigns, getCampaignCharacters } from "./tools/campaign.js";
import {
  searchSpells,
  getSpell,
  searchMonsters,
  getMonster,
  searchItems,
  getItem,
  searchFeats,
  getCondition,
  searchClasses,
  searchSubclasses,
  searchRaces,
  searchBackgrounds,
  searchClassFeatures,
  searchRacialTraits,
} from "./tools/reference.js";

export async function startServer(): Promise<void> {
  // Initialize cache instance
  const cache = new TtlCache<unknown>(60_000); // 60s TTL

  // Initialize resilience components
  const circuitBreaker = new CircuitBreaker(5, 30_000); // 5 failures, 30s cooldown
  const rateLimiter = new RateLimiter(2, 1000); // 2 req/sec

  // Initialize D&D Beyond API client
  const client = new DdbClient(cache, circuitBreaker, rateLimiter);

  // Create MCP server
  const server = new McpServer({
    name: "dndbeyond-mcp",
    version: "0.1.0",
  });

  // Register all prompts
  registerAllPrompts(server);

  // Register all resources
  registerCharacterResources(server, client);
  registerCampaignResources(server, client);

  // Register auth tools
  server.tool(
    "setup_auth",
    "Opens a browser to authenticate with D&D Beyond and save your CobaltSession cookie",
    {},
    async () => setupAuth()
  );

  server.tool(
    "check_auth",
    "Check authentication status and verify if your D&D Beyond session is valid",
    {},
    async () => checkAuth(client)
  );

  // Register character read tools
  server.tool(
    "get_character",
    "Get character details by ID or name. Use 'detail' to control output: 'summary' (basic stats), 'sheet' (comprehensive with saves/skills/features, default), or 'full' (sheet + all definitions expanded, ~15-30KB).",
    {
      characterId: z.coerce.number().optional().describe("The character ID"),
      characterName: z
        .string()
        .optional()
        .describe("The character name (case-insensitive search)"),
      detail: z
        .enum(["summary", "sheet", "full"])
        .optional()
        .describe("Detail level: 'summary', 'sheet' (default), or 'full'"),
    },
    async (params) =>
      getCharacter(client, {
        characterId: params.characterId,
        characterName: params.characterName,
        detail: params.detail,
      })
  );

  server.tool(
    "list_characters",
    "List all characters across all campaigns",
    {},
    async () => listCharacters(client)
  );

  server.tool(
    "get_character_choices",
    "Inspect a character's builder choices (class/feat/race/background): each choice's resolved value, available options, and the exact ids needed to (re)resolve it via set_class_feature_choice / set_feat_choice / set_race_trait_choice / set_background_choice. Use this to see WHY a skill/spell/option is present, or to change a meaningful pick that resolve_choices would get wrong.",
    {
      characterId: z.coerce.number().optional().describe("The character ID"),
      characterName: z.string().optional().describe("The character name (case-insensitive search)"),
    },
    async (params) =>
      getCharacterChoices(client, {
        characterId: params.characterId,
        characterName: params.characterName,
      })
  );

  server.tool(
    "get_definition",
    "Look up a specific feat, spell, class feature, racial trait, or item by name (partial match). Returns the full description.",
    {
      characterId: z.coerce.number().optional().describe("The character ID"),
      characterName: z
        .string()
        .optional()
        .describe("The character name (case-insensitive search)"),
      name: z
        .string()
        .describe(
          "Name to search for (case-insensitive partial match, e.g. 'hunter' finds Hunter's Mark)"
        ),
    },
    async (params) =>
      getDefinition(client, {
        characterId: params.characterId,
        characterName: params.characterName,
        name: params.name,
      })
  );

  // Register character write tools
  server.tool(
    "update_hp",
    "Update a character's hit points (positive = heal, negative = damage). Optionally set temporary HP.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      hpChange: z
        .coerce.number()
        .describe("HP change (positive for healing, negative for damage)"),
      tempHp: z
        .coerce.number()
        .optional()
        .describe("Set temporary hit points to this value"),
    },
    async (params) =>
      updateHp(client, {
        characterId: params.characterId,
        hpChange: params.hpChange,
        tempHp: params.tempHp,
      })
  );

  server.tool(
    "set_inspiration",
    "Grant or remove inspiration on a character",
    {
      characterId: z.coerce.number().describe("The character ID"),
      inspiration: z.boolean().describe("true to grant inspiration, false to remove it"),
    },
    async (params) =>
      setInspiration(client, {
        characterId: params.characterId,
        inspiration: params.inspiration,
      })
  );

  server.tool(
    "add_condition",
    "Apply a condition to a character. Condition IDs: 1=Blinded, 2=Charmed, 3=Deafened, 4=Frightened, 5=Grappled, 6=Incapacitated, 7=Invisible, 8=Paralyzed, 9=Petrified, 10=Poisoned, 11=Prone, 12=Restrained, 13=Stunned, 14=Unconscious, 15=Exhaustion (use level 1-6)",
    {
      characterId: z.coerce.number().describe("The character ID"),
      conditionId: z.coerce.number().describe("Condition ID (1-15)"),
      level: z.coerce.number().optional().describe("Exhaustion level (1-6). Only used for Exhaustion (conditionId=15)."),
    },
    async (params) =>
      addCondition(client, {
        characterId: params.characterId,
        conditionId: params.conditionId,
        level: params.level,
      })
  );

  server.tool(
    "remove_condition",
    "Remove a condition from a character. Condition IDs: 1=Blinded, 2=Charmed, 3=Deafened, 4=Frightened, 5=Grappled, 6=Incapacitated, 7=Invisible, 8=Paralyzed, 9=Petrified, 10=Poisoned, 11=Prone, 12=Restrained, 13=Stunned, 14=Unconscious, 15=Exhaustion",
    {
      characterId: z.coerce.number().describe("The character ID"),
      conditionId: z.coerce.number().describe("Condition ID (1-15)"),
    },
    async (params) =>
      removeCondition(client, {
        characterId: params.characterId,
        conditionId: params.conditionId,
      })
  );

  server.tool(
    "update_spell_slots",
    "Update used spell slots for a specific spell level",
    {
      characterId: z.coerce.number().describe("The character ID"),
      level: z.coerce.number().describe("Spell slot level (1-9)"),
      used: z.coerce.number().describe("Number of slots used at this level"),
    },
    async (params) =>
      updateSpellSlots(client, {
        characterId: params.characterId,
        level: params.level,
        used: params.used,
      })
  );

  server.tool(
    "update_death_saves",
    "Update death saving throw successes or failures",
    {
      characterId: z.coerce.number().describe("The character ID"),
      type: z
        .enum(["success", "failure"])
        .describe("Type of death save: 'success' or 'failure'"),
      count: z.coerce.number().describe("Number of successes or failures (0-3)"),
    },
    async (params) =>
      updateDeathSaves(client, {
        characterId: params.characterId,
        type: params.type,
        count: params.count,
      })
  );

  server.tool(
    "update_currency",
    "Update a character's currency. Use 'delta' to add/spend (e.g., delta: 50 to add, delta: -10 to spend) or 'amount' to set an absolute value.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      currency: z
        .enum(["cp", "sp", "ep", "gp", "pp"])
        .describe("Currency type: cp, sp, ep, gp, or pp"),
      amount: z.coerce.number().optional().describe("Set currency to this exact amount"),
      delta: z.coerce.number().optional().describe("Add (positive) or spend (negative) this many coins"),
    },
    async (params) =>
      updateCurrency(client, {
        characterId: params.characterId,
        currency: params.currency,
        amount: params.amount,
        delta: params.delta,
      })
  );

  server.tool(
    "set_max_hp",
    "Override a character's maximum hit points to a fixed value. Use this for fixed or manually-entered HP totals (update_hp only applies damage/healing).",
    {
      characterId: z.coerce.number().describe("The character ID"),
      maxHp: z.coerce.number().describe("The maximum HP value to set as an override"),
    },
    async (params) =>
      setMaxHp(client, {
        characterId: params.characterId,
        maxHp: params.maxHp,
      })
  );

  server.tool(
    "add_custom_proficiency",
    "Add a custom proficiency (skill, tool, or language) via D&D Beyond's Custom Proficiencies feature. Use for proficiencies not available as standard builder choices (e.g. a custom background's tool, or a rare language like Undercommon).",
    {
      characterId: z.coerce.number().describe("The character ID"),
      name: z.string().describe("Proficiency name (e.g. 'Cartographer's Tools', 'Undercommon')"),
      type: z.coerce.number().describe("Proficiency type: 1=skill, 2=tool, 3=language"),
      proficiencyLevel: z.coerce.number().optional().describe("1=half, 2=proficient, 3=expertise (default 2)"),
    },
    async (params) =>
      addCustomProficiency(client, {
        characterId: params.characterId,
        name: params.name,
        type: params.type,
        proficiencyLevel: params.proficiencyLevel,
      })
  );

  server.tool(
    "add_custom_item",
    "Add a custom (homebrew) item to a character's inventory — for items with no D&D Beyond definition (e.g. house-rule potions, quest items). For items that have a definition, use add_inventory_items instead.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      name: z.string().describe("Item name"),
      description: z.string().optional().describe("Item description / notes"),
      quantity: z.coerce.number().optional().describe("Quantity (default 1)"),
    },
    async (params) =>
      addCustomItem(client, {
        characterId: params.characterId,
        name: params.name,
        description: params.description,
        quantity: params.quantity,
      })
  );

  server.tool(
    "add_party_inventory_item",
    "Add a custom item to a campaign's shared party inventory (the campaign-wide pool not owned by any single character). For an item that belongs to one character, use add_custom_item instead. characterId must be a member of the campaign (the acting character).",
    {
      campaignId: z.coerce.number().describe("The campaign ID (from list_campaigns)"),
      characterId: z.coerce.number().describe("ID of one of your characters in that campaign (the acting member)"),
      name: z.string().describe("Item name"),
      description: z.string().optional().describe("Item description"),
      notes: z.string().optional().describe("Short notes (e.g. '15L')"),
      quantity: z.coerce.number().optional().describe("Quantity (default 1)"),
      weight: z.coerce.number().optional().describe("Weight in lb"),
      cost: z.coerce.number().optional().describe("Cost in gp"),
    },
    async (params) =>
      addPartyInventoryItem(client, {
        campaignId: params.campaignId,
        characterId: params.characterId,
        name: params.name,
        description: params.description,
        notes: params.notes,
        quantity: params.quantity,
        weight: params.weight,
        cost: params.cost,
      })
  );

  server.tool(
    "remove_party_inventory_item",
    "Remove a custom item from a campaign's shared party inventory. itemId is the party-inventory entry id shown as [ID: ...] by get_campaign_characters. characterId must be a member of the campaign.",
    {
      campaignId: z.coerce.number().describe("The campaign ID"),
      characterId: z.coerce.number().describe("ID of one of your characters in that campaign (the acting member)"),
      itemId: z.coerce.number().describe("The party-inventory entry id ([ID: ...] from get_campaign_characters)"),
    },
    async (params) =>
      removePartyInventoryItem(client, {
        campaignId: params.campaignId,
        characterId: params.characterId,
        itemId: params.itemId,
      })
  );

  server.tool(
    "use_ability",
    "Update uses of a limited-use ability (e.g., Favored Enemy, Dreadful Strike, Ki Points). Increments by 1 if 'uses' is not specified, or set exact count with 'uses'. Set uses to 0 to reset.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      abilityName: z
        .string()
        .describe(
          "Name of the ability (e.g., 'Hunter's Mark', 'Dreadful Strike')"
        ),
      uses: z
        .coerce.number()
        .optional()
        .describe(
          "Set exact number of uses expended. If omitted, increments current uses by 1."
        ),
    },
    async (params) =>
      useAbility(client, {
        characterId: params.characterId,
        abilityName: params.abilityName,
        uses: params.uses,
      })
  );

  server.tool(
    "update_pact_magic",
    "Update used pact magic slots for a Warlock",
    {
      characterId: z.coerce.number().describe("The character ID"),
      used: z.coerce.number().describe("Number of pact magic slots used"),
    },
    async (params) =>
      updatePactMagic(client, {
        characterId: params.characterId,
        used: params.used,
      })
  );

  server.tool(
    "long_rest",
    "Perform a long rest: restores HP, spell slots, pact magic, limited-use abilities, hit dice, and death saves (server-side)",
    {
      characterId: z.coerce.number().describe("The character ID"),
    },
    async (params) =>
      longRest(client, {
        characterId: params.characterId,
      })
  );

  server.tool(
    "short_rest",
    "Perform a short rest: resets pact magic, short-rest abilities, and handles hit dice (server-side)",
    {
      characterId: z.coerce.number().describe("The character ID"),
    },
    async (params) =>
      shortRest(client, {
        characterId: params.characterId,
      })
  );

  server.tool(
    "cast_spell",
    "Cast a spell and automatically decrement the appropriate spell slot or pact magic slot. Supports upcasting.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      spellName: z.string().describe("Name of the spell to cast"),
      level: z
        .coerce.number()
        .optional()
        .describe("Cast at this level (for upcasting). Defaults to spell's base level."),
    },
    async (params) =>
      castSpell(client, {
        characterId: params.characterId,
        spellName: params.spellName,
        level: params.level,
      })
  );

  // Register character creation/builder tools
  server.tool(
    "create_character",
    "Create a new D&D Beyond character. Standard build creates a blank character. Quick build creates one with a class and species pre-selected.",
    {
      method: z.enum(["standard", "quick"]).describe("Build method: 'standard' (blank) or 'quick' (pre-configured)"),
      classId: z.coerce.number().optional().describe("Class ID for quick build. Use search_classes to find IDs. 2024 PHB: 2190875=Barbarian, 2190876=Bard, 2190877=Cleric, 2190878=Druid, 2190879=Fighter, 2190880=Monk, 2190881=Paladin, 2190882=Ranger, 2190883=Rogue, 2190884=Sorcerer, 2190885=Warlock, 2190886=Wizard"),
      entityRaceId: z.coerce.number().optional().describe("Race entity ID for quick build"),
      entityRaceTypeId: z.coerce.number().optional().describe("Race entity type ID for quick build"),
    },
    async (params) =>
      createCharacter(client, {
        method: params.method,
        classId: params.classId,
        entityRaceId: params.entityRaceId,
        entityRaceTypeId: params.entityRaceTypeId,
      })
  );

  server.tool(
    "delete_character",
    "Permanently delete a character from D&D Beyond",
    {
      characterId: z.coerce.number().describe("The character ID to delete"),
    },
    async (params) =>
      deleteCharacter(client, {
        characterId: params.characterId,
      })
  );

  server.tool(
    "add_class",
    "Add a class to a character at a specified level",
    {
      characterId: z.coerce.number().describe("The character ID"),
      classId: z.coerce.number().describe("Class ID. Use search_classes to find IDs. 2024 PHB: 2190875=Barbarian, 2190876=Bard, 2190877=Cleric, 2190878=Druid, 2190879=Fighter, 2190880=Monk, 2190881=Paladin, 2190882=Ranger, 2190883=Rogue, 2190884=Sorcerer, 2190885=Warlock, 2190886=Wizard"),
      level: z.coerce.number().describe("Class level to set"),
    },
    async (params) =>
      addClass(client, {
        characterId: params.characterId,
        classId: params.classId,
        level: params.level,
      })
  );

  server.tool(
    "set_background",
    "Set a character's background",
    {
      characterId: z.coerce.number().describe("The character ID"),
      backgroundId: z.coerce.number().describe("Background ID"),
    },
    async (params) =>
      setBackground(client, {
        characterId: params.characterId,
        backgroundId: params.backgroundId,
      })
  );

  server.tool(
    "set_background_choice",
    "Configure a background proficiency or equipment choice",
    {
      characterId: z.coerce.number().describe("The character ID"),
      type: z.coerce.number().describe("Choice type"),
      choiceKey: z.string().describe("Choice key identifier"),
      choiceValue: z.coerce.number().describe("Selected choice value"),
    },
    async (params) =>
      setBackgroundChoice(client, {
        characterId: params.characterId,
        type: params.type,
        choiceKey: params.choiceKey,
        choiceValue: params.choiceValue,
      })
  );

  server.tool(
    "set_class_feature_choice",
    "Resolve a class feature choice (e.g., warlock invocation, fighting style). Get choice data from the character's choices.class array.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      classId: z.coerce.number().describe("The class definition ID"),
      classFeatureId: z.coerce.number().describe("The class feature component ID"),
      classMappingId: z.coerce.number().describe("The character's class mapping ID"),
      type: z.coerce.number().describe("Choice type from the choice object"),
      choiceKey: z.string().describe("Choice key identifier from the choice object"),
      choiceValue: z.coerce.number().describe("Selected option ID"),
      parentChoiceId: z.coerce.number().optional().describe("Parent choice ID (for nested choices)"),
    },
    async (params) =>
      setClassFeatureChoice(client, {
        characterId: params.characterId,
        classId: params.classId,
        classFeatureId: params.classFeatureId,
        classMappingId: params.classMappingId,
        type: params.type,
        choiceKey: params.choiceKey,
        choiceValue: params.choiceValue,
        parentChoiceId: params.parentChoiceId,
      })
  );

  server.tool(
    "set_race_trait_choice",
    "Resolve a race/species trait choice (e.g., giant ancestry, ability score increase, language). Get choice data from the character's choices.race array.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      racialTraitId: z.coerce.number().describe("The racial trait component ID"),
      type: z.coerce.number().describe("Choice type from the choice object"),
      choiceKey: z.string().describe("Choice key identifier from the choice object"),
      choiceValue: z.coerce.number().describe("Selected option ID"),
    },
    async (params) =>
      setRaceTraitChoice(client, {
        characterId: params.characterId,
        racialTraitId: params.racialTraitId,
        type: params.type,
        choiceKey: params.choiceKey,
        choiceValue: params.choiceValue,
      })
  );

  server.tool(
    "set_feat_choice",
    "Resolve a feat choice (e.g., ability score increase option on an origin feat). Get choice data from the character's choices.feat array.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      featId: z.coerce.number().describe("The feat component ID"),
      type: z.coerce.number().describe("Choice type from the choice object"),
      choiceKey: z.string().describe("Choice key identifier from the choice object"),
      choiceValue: z.coerce.number().describe("Selected option ID"),
    },
    async (params) =>
      setFeatChoice(client, {
        characterId: params.characterId,
        featId: params.featId,
        type: params.type,
        choiceKey: params.choiceKey,
        choiceValue: params.choiceValue,
      })
  );

  server.tool(
    "resolve_choices",
    "Auto-resolve all unresolved builder choices on a character by picking the FIRST available option for each. Handles cascading choices (resolving one may unlock more). Use after create_character to make the character builder-complete. CAUTION: 'first option' is often wrong for meaningful choices — e.g. skill picks, weapon-mastery weapons, and subclass options (Rage of the Wilds Bear/Eagle/Wolf) draw from a combined pool where the first entry may be an arbitrary weapon or an unwanted skill. Set those explicitly with set_class_feature_choice / set_feat_choice afterward. NOTE: once resolved, a choice's id gains a suffix (e.g. '3-1675296-513991331'); pass that FULL id as choiceKey when overriding it — the base id ('3-1675296') silently no-ops.",
    {
      characterId: z.coerce.number().describe("The character ID"),
    },
    async (params) =>
      resolveChoices(client, {
        characterId: params.characterId,
      })
  );

  server.tool(
    "set_species",
    "Set a character's species (race)",
    {
      characterId: z.coerce.number().describe("The character ID"),
      entityRaceId: z.coerce.number().describe("Race entity ID"),
      entityRaceTypeId: z.coerce.number().describe("Race entity type ID"),
    },
    async (params) =>
      setSpecies(client, {
        characterId: params.characterId,
        entityRaceId: params.entityRaceId,
        entityRaceTypeId: params.entityRaceTypeId,
      })
  );

  server.tool(
    "set_ability_score",
    "Set an ability score for a character. statId: 1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA. IMPORTANT: 'type' selects which underlying array is written, NOT the generation method: 1=base score (the rolled/array/point-buy value, before racial/ASI bonuses), 2=misc bonus (added on top of base+racial), 3=override (replaces the displayed total). ALWAYS set the base score (type 1) — D&D Beyond flags a character as 'Character Not Ready' (missing Ability Scores) if no base score is set, even when an override is present. Use override (type 3) only as an extra on top of a real base, never as a substitute. To enter exact final totals: set the generation method to Rolled via set_ability_score_type, then set base scores (type 1) equal to the desired totals minus any racial/ASI bonus (D&D Beyond applies those on top). Pass value=null with type 3 to clear an override.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      statId: z.coerce.number().describe("Ability stat ID (1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA)"),
      type: z.coerce.number().describe("Target array: 1=base score, 2=misc bonus, 3=override (final total)"),
      value: z.coerce.number().describe("The ability score value"),
    },
    async (params) =>
      setAbilityScore(client, {
        characterId: params.characterId,
        statId: params.statId,
        type: params.type,
        value: params.value,
      })
  );

  server.tool(
    "update_character_name",
    "Set or change a character's name",
    {
      characterId: z.coerce.number().describe("The character ID"),
      name: z.string().describe("The new character name"),
    },
    async (params) =>
      updateCharacterName(client, {
        characterId: params.characterId,
        name: params.name,
      })
  );

  server.tool(
    "set_class_level",
    "Set a character's class level. Requires the classMappingId (from the character's classes array, the 'id' field on each class entry).",
    {
      characterId: z.coerce.number().describe("The character ID"),
      classId: z.coerce.number().describe("The class definition ID"),
      classMappingId: z.coerce.number().describe("The character's class mapping ID (classes[].id)"),
      level: z.coerce.number().describe("The level to set (1-20)"),
    },
    async (params) =>
      setClassLevel(client, {
        characterId: params.characterId,
        classId: params.classId,
        classMappingId: params.classMappingId,
        level: params.level,
      })
  );

  server.tool(
    "set_ability_score_type",
    "Set the ability score generation method for a character. Must be set before assigning ability scores on standard-build characters.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      abilityScoreType: z.coerce.number().describe("1 = Standard Array, 2 = Rolled, 3 = Point Buy"),
    },
    async (params) =>
      setAbilityScoreType(client, {
        characterId: params.characterId,
        abilityScoreType: params.abilityScoreType,
      })
  );

  server.tool(
    "set_starting_equipment_type",
    "Set the starting equipment type for a character during creation",
    {
      characterId: z.coerce.number().describe("The character ID"),
      startingEquipmentType: z.coerce.number().describe("Starting equipment type (1 = Normal, 3 = Equipment)"),
    },
    async (params) =>
      setStartingEquipmentType(client, {
        characterId: params.characterId,
        startingEquipmentType: params.startingEquipmentType,
      })
  );

  server.tool(
    "add_inventory_items",
    "Add items to a character's inventory. Item entity types: 1782728300 = weapon, 2103445194 = gear/equipment.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      equipment: z.array(z.object({
        entityId: z.coerce.number().describe("Item entity ID"),
        entityTypeId: z.coerce.number().describe("Item entity type ID (1782728300=weapon, 2103445194=gear)"),
        quantity: z.coerce.number().describe("Quantity to add"),
      })).describe("Array of items to add"),
    },
    async (params) =>
      addInventoryItems(client, {
        characterId: params.characterId,
        equipment: params.equipment,
      })
  );

  server.tool(
    "equip_item",
    "Equip or unequip an inventory item. A weapon only appears as an attack action (and armor only affects AC) once equipped; add_inventory_items adds items unequipped. Pass the inventory ENTRY id (the 'id' on each entry in the character's inventory array, from get_character), not the item definition id.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      inventoryItemId: z.coerce.number().describe("Inventory entry id (inventory[].id), not the item definition id"),
      equipped: z.boolean().optional().describe("true to equip (default), false to unequip"),
    },
    async (params) =>
      setItemEquipped(client, {
        characterId: params.characterId,
        inventoryItemId: params.inventoryItemId,
        equipped: params.equipped,
      })
  );

  server.tool(
    "set_gold",
    "Set the gold amount on a character (used during character creation for starting gold)",
    {
      characterId: z.coerce.number().describe("The character ID"),
      amount: z.coerce.number().describe("Gold amount to set"),
    },
    async (params) =>
      setGold(client, {
        characterId: params.characterId,
        amount: params.amount,
      })
  );

  server.tool(
    "update_description",
    "Update a character description field. Fields: alignment (alignmentId number), lifestyle (lifestyleId number), faith, hair, skin, eyes, height, weight, age, gender, personalityTraits, ideals, bonds, flaws, backstory, otherNotes, allies, organizations, enemies.",
    {
      characterId: z.coerce.number().describe("The character ID"),
      field: z.string().describe("Description field name (e.g., 'alignment', 'backstory', 'hair')"),
      value: z.union([z.string(), z.coerce.number()]).describe("Value to set (string for text fields, number for alignment/lifestyle IDs)"),
    },
    async (params) =>
      updateDescription(client, {
        characterId: params.characterId,
        field: params.field,
        value: params.value,
      })
  );

  // Register campaign tools
  server.tool(
    "list_campaigns",
    "List all active campaigns with DM and player count",
    {},
    async () => listCampaigns(client)
  );

  server.tool(
    "get_campaign_characters",
    "Get the party roster for a specific campaign",
    {
      campaignId: z.coerce.number().describe("The campaign ID"),
    },
    async (params) =>
      getCampaignCharacters(client, {
        campaignId: params.campaignId,
      })
  );

  // Register reference tools - spells
  server.tool(
    "search_spells",
    "Search the full spell compendium by name, level, school, concentration, or ritual",
    {
      name: z.string().optional().describe("Spell name (partial match)"),
      level: z.coerce.number().optional().describe("Spell level (0-9, 0=cantrip)"),
      school: z
        .string()
        .optional()
        .describe("School of magic (e.g., evocation, abjuration)"),
      concentration: z.boolean().optional().describe("Requires concentration"),
      ritual: z.boolean().optional().describe("Can be cast as ritual"),
    },
    async (params) =>
      searchSpells(client, {
        name: params.name,
        level: params.level,
        school: params.school,
        concentration: params.concentration,
        ritual: params.ritual,
      })
  );

  server.tool(
    "get_spell",
    "Get full details for a specific spell by name from the compendium",
    {
      spellName: z.string().describe("The spell name"),
    },
    async (params) =>
      getSpell(client, { spellName: params.spellName })
  );

  // Register reference tools - monsters
  server.tool(
    "search_monsters",
    "Search for monsters by name, CR, type, or size. Supports pagination and homebrew. Note: CR/type/size filters search the first 200 alphabetical monsters. For best results, combine filters with a name search term.",
    {
      name: z.string().optional().describe("Monster name (partial match)"),
      cr: z.coerce.number().optional().describe("Challenge Rating"),
      type: z
        .string()
        .optional()
        .describe("Monster type (e.g., dragon, undead, humanoid)"),
      size: z
        .string()
        .optional()
        .describe("Size (tiny, small, medium, large, huge, gargantuan)"),
      page: z.coerce.number().optional().describe("Page number (default: 1, 20 results per page)"),
      showHomebrew: z.boolean().optional().describe("Include homebrew monsters"),
      source: z
        .string()
        .optional()
        .describe("Source book name (e.g., 'Monster Manual', 'Volo's Guide')"),
    },
    async (params) =>
      searchMonsters(client, {
        name: params.name,
        cr: params.cr,
        type: params.type,
        size: params.size,
        page: params.page,
        showHomebrew: params.showHomebrew,
        source: params.source,
      })
  );

  server.tool(
    "get_monster",
    "Get full stat block for a specific monster by name",
    {
      monsterName: z.string().describe("The monster name"),
    },
    async (params) =>
      getMonster(client, {
        monsterName: params.monsterName,
      })
  );

  // Register reference tools - items
  server.tool(
    "search_items",
    "Search for magic items by name, rarity, or type",
    {
      name: z.string().optional().describe("Item name (partial match)"),
      rarity: z
        .string()
        .optional()
        .describe(
          "Rarity (common, uncommon, rare, very rare, legendary, artifact)"
        ),
      type: z
        .string()
        .optional()
        .describe("Item type (weapon, armor, potion, ring, etc.)"),
    },
    async (params) =>
      searchItems(client, {
        name: params.name,
        rarity: params.rarity,
        type: params.type,
      })
  );

  server.tool(
    "get_item",
    "Get full details for a specific magic item by name",
    {
      itemName: z.string().describe("The item name"),
    },
    async (params) =>
      getItem(client, {
        itemName: params.itemName,
      })
  );

  // Register reference tools - feats
  server.tool(
    "search_feats",
    "Search for feats by name",
    {
      name: z.string().optional().describe("Feat name (partial match)"),
    },
    async (params) =>
      searchFeats(client, {
        name: params.name,
      })
  );

  // Register reference tools - conditions
  server.tool(
    "get_condition",
    "Get rules text for a specific condition",
    {
      conditionName: z
        .string()
        .describe("The condition name (e.g., blinded, charmed, frightened)"),
    },
    async (params) =>
      getCondition(client, {
        conditionName: params.conditionName,
      })
  );

  // Register reference tools - classes
  server.tool(
    "search_classes",
    "Search for character classes. Output includes each class id (for add_class/set_class_level) and sourceId (to tell the 2014 vs 2024 version apart). Subclasses are listed separately via search_subclasses.",
    {
      className: z.string().optional().describe("Class name (partial match)"),
    },
    async (params) =>
      searchClasses(client, {
        className: params.className,
      })
  );

  server.tool(
    "search_subclasses",
    "List subclasses for a base class (by base class id, e.g. 9 = 2014 Barbarian). Subclasses are not returned by search_classes. Non-SRD subclasses only appear when their source is owned or shared into a campaign — pass campaignId to include DM-shared subclasses. Returns each subclass id for use as the type-7 subclass choiceValue in set_class_feature_choice.",
    {
      baseClassId: z.coerce.number().describe("The base class definition id (from search_classes)"),
      campaignId: z.coerce.number().optional().describe("Campaign id to include subclasses shared by the DM"),
    },
    async (params) =>
      searchSubclasses(client, {
        baseClassId: params.baseClassId,
        campaignId: params.campaignId,
      })
  );

  // Register reference tools - races
  server.tool(
    "search_races",
    "Search for character races by name",
    {
      name: z.string().optional().describe("Race name (partial match)"),
    },
    async (params) =>
      searchRaces(client, {
        name: params.name,
      })
  );

  // Register reference tools - backgrounds
  server.tool(
    "search_backgrounds",
    "Search for character backgrounds by name",
    {
      name: z.string().optional().describe("Background name (partial match)"),
    },
    async (params) =>
      searchBackgrounds(client, {
        name: params.name,
      })
  );

  // Register reference tools - class features
  server.tool(
    "search_class_features",
    "Search for class features by name, class, or level",
    {
      name: z.string().optional().describe("Feature name (partial match)"),
      className: z.string().optional().describe("Class name to filter by (e.g., 'Fighter', 'Wizard')"),
      level: z.coerce.number().optional().describe("Class level requirement"),
    },
    async (params) =>
      searchClassFeatures(client, {
        name: params.name,
        className: params.className,
        level: params.level,
      })
  );

  // Register reference tools - racial traits
  server.tool(
    "search_racial_traits",
    "Search for racial traits by name or race",
    {
      name: z.string().optional().describe("Trait name (partial match)"),
      raceName: z.string().optional().describe("Race name to filter by (e.g., 'Elf', 'Dwarf')"),
    },
    async (params) =>
      searchRacialTraits(client, {
        name: params.name,
        raceName: params.raceName,
      })
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error("dndbeyond-mcp: shutting down...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error("dndbeyond-mcp: server running");
}
