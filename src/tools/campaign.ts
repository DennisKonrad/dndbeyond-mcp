import { DdbClient } from "../api/client.js";
import { ENDPOINTS } from "../api/endpoints.js";
import type { DdbCampaign, DdbCampaignCharacter2, DdbPartyInventory } from "../types/api.js";
import type { DdbCharacter } from "../types/character.js";
import { calculateMaxHp, calculateCurrentHp, calculateAc } from "../utils/character-calculations.js";

const CAMPAIGN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function listCampaigns(client: DdbClient, includeAll?: boolean) {
  // client.get() auto-unwraps the { success, data } envelope
  // Use user-campaigns endpoint when includeAll is true, otherwise active-campaigns (default)
  const endpoint = includeAll ? ENDPOINTS.campaign.userCampaigns() : ENDPOINTS.campaign.list();
  const cacheKey = includeAll ? "user-campaigns" : "campaigns";
  const campaigns = await client.get<DdbCampaign[]>(
    endpoint,
    cacheKey,
    CAMPAIGN_CACHE_TTL
  );

  if (!campaigns || campaigns.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No active campaigns found.",
        },
      ],
    };
  }

  const lines = ["Active Campaigns:", ""];
  for (const campaign of campaigns) {
    const playerCount = campaign.playerCount;
    lines.push(
      `• ${campaign.name} [ID: ${campaign.id}] (DM: ${campaign.dmUsername}, ${playerCount} player${playerCount !== 1 ? "s" : ""})`
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text: lines.join("\n"),
      },
    ],
  };
}

export async function getCampaignCharacters(
  client: DdbClient,
  params: { campaignId: number; includeAll?: boolean }
) {
  // First fetch campaigns to verify the campaign exists
  const endpoint = params.includeAll ? ENDPOINTS.campaign.userCampaigns() : ENDPOINTS.campaign.list();
  const cacheKey = params.includeAll ? "user-campaigns" : "campaigns";
  const campaigns = await client.get<DdbCampaign[]>(
    endpoint,
    cacheKey,
    CAMPAIGN_CACHE_TTL
  );

  const campaign = campaigns.find((c) => c.id === params.campaignId);
  if (!campaign) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Campaign ${params.campaignId} not found.`,
        },
      ],
    };
  }

  // Fetch characters from the new endpoint
  const characters = await client.get<DdbCampaignCharacter2[]>(
    ENDPOINTS.campaign.characters(params.campaignId),
    `campaign:${params.campaignId}:characters`,
    CAMPAIGN_CACHE_TTL
  );

  if (characters.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Campaign "${campaign.name}" has no characters yet.`,
        },
      ],
    };
  }

  const lines = [`Party Roster for "${campaign.name}":`, ""];
  for (const character of characters) {
    lines.push(`• ${character.name} [ID: ${character.id}] (${character.userName})`);
  }

  lines.push(await formatPartyInventory(client, params.campaignId));

  return {
    content: [
      {
        type: "text" as const,
        text: lines.join("\n"),
      },
    ],
  };
}

// Fetches and formats the shared party inventory (campaign-wide, not owned by any
// character). A failure here must not break the roster, so it degrades to a note.
async function formatPartyInventory(client: DdbClient, campaignId: number): Promise<string> {
  let inventory: DdbPartyInventory;
  try {
    inventory = await client.get<DdbPartyInventory>(
      ENDPOINTS.campaign.partyInventory(campaignId),
      `campaign:${campaignId}:party-inventory`,
      CAMPAIGN_CACHE_TTL
    );
  } catch {
    return "\nParty Inventory: unavailable";
  }

  const items = inventory?.partyItems ?? [];
  if (items.length === 0) return "\nParty Inventory: empty";

  const itemLines = items.map((item) => {
    const qty = item.quantity > 1 ? ` (x${item.quantity})` : "";
    return `  - ${item.definition.name}${qty} [ID: ${item.id}]`;
  });
  return `\nParty Inventory (${items.length} items):\n${itemLines.join("\n")}`;
}

// Quick combat status for the whole party: current/max HP, AC, temp HP, and a
// DOWN marker. Reads each member's sheet FRESH (invalidates cache) so mid-combat
// numbers are current rather than stale.
export async function getPartyStatus(
  client: DdbClient,
  params: { campaignId: number }
) {
  const members = await client.get<DdbCampaignCharacter2[]>(
    ENDPOINTS.campaign.characters(params.campaignId),
    `campaign:${params.campaignId}:characters`,
    CAMPAIGN_CACHE_TTL
  );

  if (!members || members.length === 0) {
    return { content: [{ type: "text" as const, text: `No characters found for campaign ${params.campaignId}.` }] };
  }

  const lines: string[] = ["Party Status:", ""];
  let curSum = 0;
  let maxSum = 0;

  for (const member of members) {
    let row: string;
    try {
      client.invalidateCache(`character:${member.id}`);
      const c = await client.get<DdbCharacter>(
        ENDPOINTS.character.get(member.id),
        `character:${member.id}`,
        60_000
      );
      const max = calculateMaxHp(c);
      const cur = calculateCurrentHp(c);
      const ac = calculateAc(c);
      const temp = c.temporaryHitPoints || 0;
      curSum += cur;
      maxSum += max;

      const flags: string[] = [];
      if (temp > 0) flags.push(`+${temp} temp`);
      if (cur <= 0) flags.push("DOWN");
      const pct = max > 0 ? Math.round((cur / max) * 100) : 0;
      if (cur > 0 && pct <= 25) flags.push("bloodied <25%");
      const flagStr = flags.length ? `  [${flags.join(", ")}]` : "";
      row = `• ${member.name} — ${cur}/${max} HP · AC ${ac}${flagStr}`;
    } catch {
      row = `• ${member.name} — (sheet unavailable)`;
    }
    lines.push(row);
  }

  lines.push("", `Party HP: ${curSum}/${maxSum}`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
