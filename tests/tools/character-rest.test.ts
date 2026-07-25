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

  it("should state plainly that the short rest was not applied", async () => {
    // The route it can reach is preview-only; reporting success would repeat
    // the exact bug that hid the long-rest failure.
    const result = await shortRest(mockClient, { characterId: 123 });

    expect(result.content[0].text).toContain("NOT applied to character 123");
    expect(result.content[0].text).not.toContain("Short rest completed");
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("should surface the preview text when D&D Beyond returns one", async () => {
    vi.mocked(mockClient.get).mockResolvedValue({ data: "Up to 1 Hit Dice" });

    const result = await shortRest(mockClient, { characterId: 123 });

    expect(result.content[0].text).toContain("would restore: Up to 1 Hit Dice");
  });

  it("should still report when the preview call fails", async () => {
    vi.mocked(mockClient.get).mockRejectedValue(new Error("boom"));

    const result = await shortRest(mockClient, { characterId: 123 });

    expect(result.content[0].text).toContain("NOT applied to character 123");
  });
});
