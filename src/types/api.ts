export interface DdbApiResponse<T> {
  id: number;
  success: boolean;
  message: string;
  data: T;
  pagination: unknown | null;
}

export interface DdbErrorResponse {
  success: false;
  message: string;
  data: {
    serverMessage: string;
    errorCode: string;
  };
}

export interface DdbCampaignResponse {
  status: string;
  data: DdbCampaign[];
}

export interface DdbCampaign {
  id: number;
  name: string;
  dmId: number;
  dmUsername: string;
  playerCount: number;
  dateCreated: string;
  characters?: DdbCampaignCharacter2[];
}

export interface DdbCampaignCharacter {
  characterId: number;
  characterName: string;
  userId: number;
  username: string;
}

export interface DdbCampaignCharacter2 {
  id: number;
  name: string;
  userId: number;
  userName: string;
  avatarUrl: string;
  characterStatus: number;
  isAssigned: boolean;
}

// Shared party inventory (campaign-wide). Returned by the party-inventory endpoint.
export interface DdbPartyInventoryItem {
  id: number; // party-inventory entry id (the DELETE "mappingId")
  quantity: number;
  definition: {
    id?: number; // custom-item definition id (the DELETE/PUT "id")
    name: string;
    filterType?: string;
    type?: string;
    weight?: number | null;
    cost?: number | null;
    description?: string;
    // NB: the party-inventory GET does NOT return `notes`, so it cannot be preserved on edit.
  };
}

export interface DdbPartyInventory {
  partyItems?: DdbPartyInventoryItem[];
}
