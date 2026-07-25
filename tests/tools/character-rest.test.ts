import { describe, it, expect, vi, beforeEach } from "vitest";
import { longRest, shortRest } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";

describe("longRest", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue({}),
      getRaw: vi.fn(),
      put: vi.fn(),
      post: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  it("should POST the long rest with characterId in the body", async () => {
    const result = await longRest(mockClient, { characterId: 123 });

    expect(result.content[0].text).toContain("Long rest completed for character 123");
    expect(result.content[0].text).toContain("HP, spell slots, and long-rest abilities have been restored");

    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/rest/long"),
      { characterId: 123 },
      ["character:123"]
    );
  });

  it("should not send characterId in the query string", async () => {
    // The endpoint reads characterId from the body; a query-string GET reaches
    // the server without the parameter it actually validates.
    await longRest(mockClient, { characterId: 123 });

    const [url] = vi.mocked(mockClient.post).mock.calls[0];
    expect(url).not.toContain("characterId=");
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});

describe("shortRest", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue({}),
      getRaw: vi.fn(),
      put: vi.fn(),
      post: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  const CHAR = {
    classes: [{ id: 235229297, definition: { name: "Fighter" }, hitDiceUsed: 1 }],
  };

  it("should POST classHitDiceUsed, not the sheet's local hitDiceUsed name", async () => {
    // The sheet renames hitDiceUsed to classHitDiceUsed on dispatch; sending
    // the local name is what made every earlier attempt fail with a 500.
    vi.mocked(mockClient.get).mockResolvedValue(CHAR);

    await shortRest(mockClient, { characterId: 123 });

    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/rest/short"),
      { characterId: 123, classHitDiceUsed: { "235229297": 1 }, resetMaxHpModifier: false },
      ["character:123"]
    );
  });

  it("should default each class to its current hit dice count", async () => {
    vi.mocked(mockClient.get).mockResolvedValue(CHAR);

    await shortRest(mockClient, { characterId: 123 });

    const [, body] = vi.mocked(mockClient.post).mock.calls[0];
    // Absolute total, not a delta — passing 0 here would refund a spent die.
    expect((body as { classHitDiceUsed: Record<string, number> }).classHitDiceUsed["235229297"]).toBe(1);
  });

  it("should pass through explicit hit dice spending", async () => {
    vi.mocked(mockClient.get).mockResolvedValue(CHAR);

    await shortRest(mockClient, { characterId: 123, classHitDiceUsed: { "235229297": 3 }, resetMaxHpModifier: true });

    expect(mockClient.post).toHaveBeenCalledWith(
      expect.anything(),
      { characterId: 123, classHitDiceUsed: { "235229297": 3 }, resetMaxHpModifier: true },
      ["character:123"]
    );
  });

  it("should report completion with the hit dice actually spent", async () => {
    vi.mocked(mockClient.get).mockResolvedValue(CHAR);

    const result = await shortRest(mockClient, { characterId: 123, classHitDiceUsed: { "235229297": 2 } });

    expect(result.content[0].text).toContain("Short rest completed for character 123");
    expect(result.content[0].text).toContain("Fighter: 2 hit dice used");
  });
});
