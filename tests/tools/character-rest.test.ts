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

  it("should call server-side short rest endpoint and invalidate cache", async () => {
    const result = await shortRest(mockClient, { characterId: 123 });

    expect(result.content[0].text).toContain("Short rest completed for character 123");
    expect(result.content[0].text).toContain("Pact magic and short-rest abilities have been restored");

    // Should call the server-side rest endpoint
    expect(mockClient.get).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/rest/short?characterId=123"),
      expect.any(String),
      0
    );

    // Should invalidate character cache
    expect(mockClient.invalidateCache).toHaveBeenCalledWith("character:123");
  });
});
