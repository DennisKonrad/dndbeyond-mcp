export const DDB_CHARACTER_SERVICE = "https://character-service.dndbeyond.com";
export const DDB_MONSTER_SERVICE = "https://monster-service.dndbeyond.com";
export const DDB_WATERDEEP = "https://www.dndbeyond.com";

export const ENDPOINTS = {
  character: {
    get: (id: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/${id}?includeCustomItems=true`,
    list: (userId: number) => `${DDB_CHARACTER_SERVICE}/character/v5/characters/list?userId=${userId}`,
    // New-style gameplay endpoints (characterId in body/query, not path)
    updateHp: () => `${DDB_CHARACTER_SERVICE}/character/v5/life/hp/damage-taken`,
    updateLimitedUse: () => `${DDB_CHARACTER_SERVICE}/character/v5/action/limited-use`,
    setInspiration: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/inspiration`,
    condition: () => `${DDB_CHARACTER_SERVICE}/character/v5/condition`,
    rest: {
      // CAUTION: the GET forms of both rest routes are PREVIEW endpoints. They
      // answer 200 { success: true, message: "Successfully received <x> rest
      // text", data: "6 Hit Points, Up to 1 Hit Dice" } and change nothing —
      // measured 2026-07-25 on a throwaway character. Calling them and
      // reporting success is a silent no-op.
      //
      // Applying a rest is a POST with characterId in the BODY. Short rest also
      // needs classHitDiceUsed — the field name comes from D&D Beyond's own
      // action creator, shortRest(classHitDiceUsed, resetMaxHpModifier); the
      // sheet holds it as "hitDiceUsed" locally and renames it on dispatch,
      // which is why every body using that local name answered 500.
      shortPreview: (characterId: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/rest/short?characterId=${characterId}`,
      short: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/rest/short`,
      long: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/rest/long`,
    },
    // Deprecated v5 endpoints (return 404, kept for reference)
    updateSpellSlots: (id: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/${id}/spell/slots`,
    updateDeathSaves: (id: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/${id}/life/death-saves`,
    updateCurrency: (id: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/${id}/inventory/currency`,
    updatePactMagic: (id: number) => `${DDB_CHARACTER_SERVICE}/character/v5/character/${id}/spell/pact-magic`,
    builder: {
      standardBuild: () => `${DDB_CHARACTER_SERVICE}/character/v5/builder/standard-build`,
      quickBuild: () => `${DDB_CHARACTER_SERVICE}/character/v5/builder/quick-build`,
    },
    addClass: () => `${DDB_CHARACTER_SERVICE}/character/v5/class`,
    setBackground: () => `${DDB_CHARACTER_SERVICE}/character/v5/background`,
    setBackgroundChoice: () => `${DDB_CHARACTER_SERVICE}/character/v5/background/choice`,
    setClassFeatureChoice: () => `${DDB_CHARACTER_SERVICE}/character/v5/class/feature/choice`,
    setRaceTraitChoice: () => `${DDB_CHARACTER_SERVICE}/character/v5/race/trait/choice`,
    setFeatChoice: () => `${DDB_CHARACTER_SERVICE}/character/v5/feat/choice`,
    setRace: () => `${DDB_CHARACTER_SERVICE}/character/v5/race`,
    setAbilityScore: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/ability-score`,
    setPreferences: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/preferences`,
    setAbilityScoreType: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/ability-score/type`,
    setClassLevel: () => `${DDB_CHARACTER_SERVICE}/character/v5/class/level`,
    updateName: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/name`,
    updateAlignment: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/alignment`,
    updateLifestyle: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/lifestyle`,
    updateFaith: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/faith`,
    updateTraits: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/traits`,
    updateNotes: () => `${DDB_CHARACTER_SERVICE}/character/v5/description/notes`,
    updateAppearance: (field: string) => `${DDB_CHARACTER_SERVICE}/character/v5/description/${field}`,
    // Current (non-deprecated) write endpoints with characterId in the body
    setMaxHp: () => `${DDB_CHARACTER_SERVICE}/character/v5/life/hp/override`,
    // Sets experience points. Body: { characterId, currentXp }. Captured from the
    // DDB web app — the XP editor PUTs to /character/progression, not /xp.
    setXp: () => `${DDB_CHARACTER_SERVICE}/character/v5/character/progression`,
    customProficiency: () => `${DDB_CHARACTER_SERVICE}/character/v5/custom/proficiency`,
    inventory: {
      addItems: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/item`,
      // Remove an inventory item. DELETE with body { characterId, id: <entryId> }.
      // Same URL as addItems; verified live against DDB.
      removeItem: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/item`,
      setGold: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/currency/gold`,
      // Working bulk-currency endpoint (replaces the deprecated per-id path above)
      currency: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/currency`,
      customItem: () => `${DDB_CHARACTER_SERVICE}/character/v5/custom/item`,
      // Same custom-item endpoint (v5.1) that also accepts party-container fields,
      // used to add a custom item to the shared party inventory instead of a character.
      partyCustomItem: () => `${DDB_CHARACTER_SERVICE}/character/v5.1/custom/item`,
      // Equip / unequip an inventory item. Body: { characterId, id, value: boolean }.
      // A weapon only shows up as an attack action once it is equipped.
      equipped: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/item/equipped`,
      setStartingType: () => `${DDB_CHARACTER_SERVICE}/character/v5/inventory/starting-type`,
    },
    delete: () => `${DDB_CHARACTER_SERVICE}/character/v5/character`,
  },
  gameData: {
    items: (campaignId?: number) => {
      const campaign = campaignId ? `&campaignId=${campaignId}` : "";
      return `${DDB_CHARACTER_SERVICE}/character/v5/game-data/items?sharingSetting=2${campaign}`;
    },
    feats: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/feats`,
    classes: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/classes`,
    // Subclasses are NOT returned by the classes endpoint; they require baseClassId.
    // Non-SRD subclasses only appear when the owning source is shared via campaignId.
    subclasses: (baseClassId: number, campaignId?: number) => {
      const campaign = campaignId ? `&campaignId=${campaignId}` : "";
      return `${DDB_CHARACTER_SERVICE}/character/v5/game-data/subclasses?sharingSetting=2&baseClassId=${baseClassId}${campaign}`;
    },
    races: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/races`,
    backgrounds: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/backgrounds`,
    alwaysKnownSpells: (classId: number, classLevel: number = 20) =>
      `${DDB_CHARACTER_SERVICE}/character/v5/game-data/always-known-spells?classId=${classId}&classLevel=${classLevel}&sharingSetting=2`,
    alwaysPreparedSpells: (classId: number, classLevel: number = 20) =>
      `${DDB_CHARACTER_SERVICE}/character/v5/game-data/always-prepared-spells?classId=${classId}&classLevel=${classLevel}&sharingSetting=2`,
    // Both /collection endpoints are dead ends, verified 2026-07-25:
    // class-feature answers 404, racial-trait answers 200 with an empty
    // definitionData for every parameter combination tried. Unused — class
    // features come from classes(), racial traits from races(); both catalogues
    // carry them inline. Kept only to document the dead ends.
    classFeatureCollection: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/class-feature/collection`,
    racialTraitCollection: () => `${DDB_CHARACTER_SERVICE}/character/v5/game-data/racial-trait/collection`,
  },
  monster: {
    search: (search: string = "", skip: number = 0, take: number = 20, showHomebrew?: boolean, sources?: string) => {
      const homebrewParam = showHomebrew ? "&showHomebrew=t" : "";
      const sourcesParam = sources ? `&sources=${encodeURIComponent(sources)}` : "";
      return `${DDB_MONSTER_SERVICE}/v1/Monster?search=${encodeURIComponent(search)}&skip=${skip}&take=${take}${homebrewParam}${sourcesParam}`;
    },
    get: (id: number) => `${DDB_MONSTER_SERVICE}/v1/Monster/${id}`,
    getByIds: (ids: number[]) => {
      const idParams = ids.map((id) => `ids=${id}`).join("&");
      return `${DDB_MONSTER_SERVICE}/v1/Monster?${idParams}`;
    },
  },
  campaign: {
    list: () => `${DDB_WATERDEEP}/api/campaign/stt/active-campaigns`,
    userCampaigns: () => `${DDB_WATERDEEP}/api/campaign/stt/user-campaigns`,
    characters: (campaignId: number) => `${DDB_WATERDEEP}/api/campaign/stt/active-short-characters/${campaignId}`,
    // Shared party inventory (campaign-wide, not owned by any character). Undocumented
    // character-service endpoint; returns { success, data: { partyItems: [...] } }.
    partyInventory: (campaignId: number) => `${DDB_CHARACTER_SERVICE}/character/v5/party/inventory/${campaignId}`,
  },
  config: {
    json: () => `${DDB_WATERDEEP}/api/config/json`,
  },
  // The homebrew magic-item builder is a server-rendered, CSRF-protected HTML form
  // on www.dndbeyond.com — NOT a JSON API. A real (mechanically-effective) item is
  // created by copying a base item, then editing core fields; granted modifiers are
  // managed through a separate /modifier flow keyed by the item's entityTypeId.
  homebrew: {
    // entityTypeId of a magic-item definition. Used both in the modifier-create URL
    // and as the entityTypeId when adding the finished item to a character inventory.
    MAGIC_ITEM_ENTITY_TYPE_ID: 112130694,
    createMagicItem: () => `${DDB_WATERDEEP}/homebrew/creations/create-magic-item`,
    // Slug-free editor view: D&D Beyond redirects this to the canonical
    // /magic-items/{id}-{slug}/edit page, so we never have to guess the slug.
    editMagicItem: (itemId: number, entityTypeId: number = 112130694) =>
      `${DDB_WATERDEEP}/homebrew/creations/edit?entityTypeId=${entityTypeId}&id=${itemId}`,
    createModifier: (itemId: number, entityTypeId: number) =>
      `${DDB_WATERDEEP}/modifier/create/${itemId}-${entityTypeId}/0`,
    deleteModifier: (modifierId: number) => `${DDB_WATERDEEP}/modifier/${modifierId}/delete`,
  },
} as const;
