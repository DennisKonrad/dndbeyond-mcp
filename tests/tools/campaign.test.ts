import { describe, it, expect, beforeEach, vi } from "vitest";
import { listCampaigns, getCampaignCharacters, getPartyStatus } from "../../src/tools/campaign.js";
import { DdbClient } from "../../src/api/client.js";
import type { DdbCampaign } from "../../src/types/api.js";

const sampleCampaigns: DdbCampaign[] = [
  {
    id: 101,
    name: "Lost Mines of Phandelver",
    dmId: 1,
    dmUsername: "DungeonMaster",
    playerCount: 3,
    dateCreated: "1/1/2026",
  },
  {
    id: 102,
    name: "Curse of Strahd",
    dmId: 2,
    dmUsername: "DarkDM",
    playerCount: 1,
    dateCreated: "2/1/2026",
  },
];

const sampleCharacters101 = [
  { id: 1001, name: "Thorin Stonehammer", userId: 10, userName: "player1", avatarUrl: "", characterStatus: 1, isAssigned: true },
  { id: 1002, name: "Elara Moonwhisper", userId: 11, userName: "player2", avatarUrl: "", characterStatus: 1, isAssigned: true },
  { id: 1003, name: "Grimjaw", userId: 12, userName: "player3", avatarUrl: "", characterStatus: 1, isAssigned: true },
];

const sampleCharacters102 = [
  { id: 2001, name: "Van Helsing", userId: 20, userName: "hunter", avatarUrl: "", characterStatus: 1, isAssigned: true },
];

describe("campaign tools", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      getRaw: vi.fn(),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
    vi.clearAllMocks();
  });

  describe("listCampaigns", () => {
    it("shouldFormatCampaignListCorrectly", async () => {
      vi.mocked(mockClient.get).mockResolvedValue(sampleCampaigns);

      const result = await listCampaigns(mockClient);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Active Campaigns:");
      expect(result.content[0].text).toContain("Lost Mines of Phandelver");
      expect(result.content[0].text).toContain("[ID: 101]");
      expect(result.content[0].text).toContain("DM: DungeonMaster");
      expect(result.content[0].text).toContain("3 players");
      expect(result.content[0].text).toContain("Curse of Strahd");
      expect(result.content[0].text).toContain("[ID: 102]");
      expect(result.content[0].text).toContain("DM: DarkDM");
      expect(result.content[0].text).toContain("1 player");
    });

    it("shouldHandleEmptyCampaignList", async () => {
      vi.mocked(mockClient.get).mockResolvedValue([]);

      const result = await listCampaigns(mockClient);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("No active campaigns found.");
    });

    it("shouldUseCampaignCacheKey", async () => {
      vi.mocked(mockClient.get).mockResolvedValue(sampleCampaigns);

      await listCampaigns(mockClient);

      expect(mockClient.get).toHaveBeenCalledWith(
        expect.any(String),
        "campaigns",
        expect.any(Number)
      );
    });

    it("shouldUseUserCampaignsEndpointWhenIncludeAllIsTrue", async () => {
      vi.mocked(mockClient.get).mockResolvedValue(sampleCampaigns);

      await listCampaigns(mockClient, true);

      const callUrl = vi.mocked(mockClient.get).mock.calls[0][0];
      expect(callUrl).toContain("user-campaigns");
      expect(mockClient.get).toHaveBeenCalledWith(
        expect.any(String),
        "user-campaigns",
        expect.any(Number)
      );
    });
  });

  describe("getCampaignCharacters", () => {
    it("shouldReturnFormattedPartyRoster", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce(sampleCampaigns)
        .mockResolvedValueOnce(sampleCharacters101);

      const result = await getCampaignCharacters(mockClient, { campaignId: 101 });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain('Party Roster for "Lost Mines of Phandelver"');
      expect(result.content[0].text).toContain("Thorin Stonehammer [ID: 1001] (player1)");
      expect(result.content[0].text).toContain("Elara Moonwhisper [ID: 1002] (player2)");
      expect(result.content[0].text).toContain("Grimjaw [ID: 1003] (player3)");
    });

    it("shouldAppendSharedPartyInventory", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce(sampleCampaigns)
        .mockResolvedValueOnce(sampleCharacters101)
        .mockResolvedValueOnce({
          partyItems: [
            { id: 1, quantity: 1, definition: { name: "Map", filterType: "Other Gear" } },
            { id: 2, quantity: 3, definition: { name: "Torch", filterType: "Other Gear" } },
          ],
        });

      const text = (await getCampaignCharacters(mockClient, { campaignId: 101 })).content[0].text;

      expect(text).toContain("Party Inventory (2 items):");
      expect(text).toContain("- Map");
      expect(text).toContain("- Torch (x3)");
    });

    it("shouldShowEmptyWhenPartyInventoryHasNoItems", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce(sampleCampaigns)
        .mockResolvedValueOnce(sampleCharacters101)
        .mockResolvedValueOnce({ partyItems: [] });

      const text = (await getCampaignCharacters(mockClient, { campaignId: 101 })).content[0].text;

      expect(text).toContain("Party Inventory: empty");
    });

    it("shouldDegradeGracefullyWhenPartyInventoryFails", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce(sampleCampaigns)
        .mockResolvedValueOnce(sampleCharacters101)
        .mockRejectedValueOnce(new Error("404 Not Found"));

      const text = (await getCampaignCharacters(mockClient, { campaignId: 101 })).content[0].text;

      // Roster still renders; inventory degrades to a note instead of throwing.
      expect(text).toContain("Thorin Stonehammer [ID: 1001]");
      expect(text).toContain("Party Inventory: unavailable");
    });

    it("shouldUsePartyInventoryCacheKey", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce(sampleCampaigns)
        .mockResolvedValueOnce(sampleCharacters101)
        .mockResolvedValueOnce({ partyItems: [] });

      await getCampaignCharacters(mockClient, { campaignId: 101 });

      expect(mockClient.get).toHaveBeenCalledWith(
        expect.stringContaining("/party/inventory/101"),
        "campaign:101:party-inventory",
        expect.any(Number)
      );
    });

    it("shouldHandleCampaignNotFound", async () => {
      vi.mocked(mockClient.get).mockResolvedValue(sampleCampaigns);

      const result = await getCampaignCharacters(mockClient, { campaignId: 999 });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("Campaign 999 not found.");
    });

    it("shouldHandleCampaignWithNoCharacters", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce([
          {
            id: 103,
            name: "Empty Campaign",
            dmId: 3,
            dmUsername: "NewDM",
            playerCount: 0,
            dateCreated: "1/1/2026",
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await getCampaignCharacters(mockClient, { campaignId: 103 });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe('Campaign "Empty Campaign" has no characters yet.');
    });

    it("shouldUseCampaignSpecificCacheKey", async () => {
      vi.mocked(mockClient.get).mockResolvedValue(sampleCampaigns);

      await getCampaignCharacters(mockClient, { campaignId: 101 });

      expect(mockClient.get).toHaveBeenCalledWith(
        expect.any(String),
        "campaign:101:characters",
        expect.any(Number)
      );
    });
  });

  describe("getPartyStatus", () => {
    // Minimal character usable by calculateMaxHp/CurrentHp/Ac.
    const mkChar = (over: Record<string, unknown>) => ({
      stats: [{ id: 2, value: 10 }, { id: 3, value: 10 }, { id: 5, value: 10 }],
      bonusStats: [],
      overrideStats: [],
      modifiers: {},
      classes: [{ level: 3, definition: { name: "Fighter" } }],
      inventory: [],
      bonusHitPoints: null,
      overrideHitPoints: null,
      temporaryHitPoints: 0,
      ...over,
    });

    it("shouldReportPerCharacterAndTotalHp", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce([
          { id: 1, name: "Alpha" },
          { id: 2, name: "Bravo" },
        ])
        .mockResolvedValueOnce(mkChar({ baseHitPoints: 20, removedHitPoints: 5 }))   // 15/20
        .mockResolvedValueOnce(mkChar({ baseHitPoints: 30, removedHitPoints: 30 })); // 0/30 DOWN

      const text = (await getPartyStatus(mockClient, { campaignId: 101 })).content[0].text;

      expect(text).toContain("Alpha — 15/20 HP · AC 10");
      expect(text).toContain("Bravo — 0/30 HP · AC 10");
      expect(text).toContain("[DOWN]");
      expect(text).toContain("Party HP: 15/50");
    });

    it("shouldReadEachSheetFresh", async () => {
      vi.mocked(mockClient.get)
        .mockResolvedValueOnce([{ id: 7, name: "Solo" }])
        .mockResolvedValueOnce(mkChar({ baseHitPoints: 10, removedHitPoints: 0 }));

      await getPartyStatus(mockClient, { campaignId: 101 });

      expect(mockClient.invalidateCache).toHaveBeenCalledWith("character:7");
    });
  });
});
