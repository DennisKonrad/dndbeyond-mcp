import { getAllCookies } from "./auth.js";
import { ENDPOINTS } from "./endpoints.js";

// The D&D Beyond homebrew magic-item builder is a classic server-rendered HTML
// form (ASP.NET-style) protected by a per-page security-token + authenticity-token
// pair, authenticated by the site session cookies (CobaltSession et al.) — NOT by
// the bearer token used for character-service. So this client talks form-encoded
// HTTP to www.dndbeyond.com and scrapes the tokens out of each page before posting.
//
// Flow to create a mechanically-effective item:
//   1. createFromBase(typeId, baseItemId) -> copies a base item, returns {itemId, slug}
//   2. saveCoreFields(...)               -> sets name / rarity / attunement / description
//   3. addModifier(...)                  -> adds each granted modifier (e.g. +1 initiative)
// The finished item is a real definition with grantedModifiers, addable to a
// character via the normal inventory endpoint (entityTypeId MAGIC_ITEM_ENTITY_TYPE_ID).

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface HomebrewItemRef {
  itemId: number;
  entityTypeId: number;
}

export interface ModifierFields {
  typeId: number;
  subTypeId?: number;
  fixedValue?: number;
  diceCount?: number;
  diceValue?: number;
  restriction?: string;
  requiresAttunement?: boolean;
}

export interface CoreItemFields {
  name: string;
  rarityId: number;
  description?: string;
  requiresAttunement?: boolean;
  attunementDescription?: string;
  weight?: number;
  notes?: string;
  /** Number of limited-use charges; renders a tickable counter on the sheet. */
  charges?: number;
  /** charge-reset-condition id: 1=Short Rest, 2=Long Rest, 3=Dawn, 4=Consumable, 5=Other. */
  chargeResetId?: number;
  /** Free-text reset description (e.g. shown when reset condition is Other). */
  chargeResetDescription?: string;
}

/** Extract a single hidden/text input value by name. */
function inputValue(html: string, name: string): string {
  const re = new RegExp(
    `<input[^>]*name="${name}"[^>]*value="([^"]*)"|<input[^>]*value="([^"]*)"[^>]*name="${name}"`,
    "i",
  );
  const m = html.match(re);
  return (m && (m[1] ?? m[2])) || "";
}

/** Extract the currently-selected <option> value of a <select> by name. */
function selectedOption(html: string, name: string): string {
  const block = html.match(new RegExp(`name="${name}"[\\s\\S]*?</select>`, "i"));
  if (!block) return "";
  const sel = block[0].match(/<option[^>]*value="([^"]*)"[^>]*selected/i);
  return sel ? sel[1] : "";
}

export class HomebrewClient {
  private cookieHeader: string | null = null;

  private async cookies(): Promise<string> {
    if (this.cookieHeader === null) {
      const all = await getAllCookies();
      if (all.length === 0) {
        throw new Error(
          "No D&D Beyond session cookies found. Run setup to authenticate before creating homebrew.",
        );
      }
      this.cookieHeader = all.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    return this.cookieHeader;
  }

  private async getPage(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { Cookie: await this.cookies(), "User-Agent": UA },
    });
    if (!res.ok) {
      throw new Error(`Homebrew GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  private async postForm(
    url: string,
    fields: Record<string, string>,
    referer: string,
  ): Promise<{ finalUrl: string }> {
    // Don't auto-follow: a successful homebrew POST replies 302 -> the editor page
    // (which can be ~400 KB). We only need the redirect Location, so reading it from
    // the header is both faster and avoids spurious 404s on the followed GET.
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: await this.cookies(),
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: referer,
      },
      body: new URLSearchParams(fields).toString(),
    });
    // 2xx (re-rendered form) and 3xx (redirect to editor) both mean success.
    if (res.status >= 400) {
      throw new Error(`Homebrew POST ${url} failed: ${res.status} ${res.statusText}`);
    }
    const location = res.headers.get("location") ?? "";
    const finalUrl = location
      ? new URL(location, "https://www.dndbeyond.com").toString()
      : res.url;
    // Drain the body so the socket can be released (node keeps the loop alive otherwise).
    await res.text().catch(() => undefined);
    return { finalUrl };
  }

  private tokens(html: string): { security: string; authenticity: string } {
    const security = inputValue(html, "security-token");
    const authenticity = inputValue(html, "authenticity-token");
    if (!security || !authenticity) {
      throw new Error(
        "Could not read homebrew CSRF tokens — D&D Beyond session may be expired (re-run setup).",
      );
    }
    return { security, authenticity };
  }

  /**
   * Create a homebrew magic item by copying an existing base item. Prefer a base
   * with no granted modifiers (e.g. Clockwork Amulet) so nothing has to be stripped.
   * Returns the new item's id + url slug.
   */
  async createFromBase(typeId: number, baseItemId: number): Promise<HomebrewItemRef> {
    const createUrl = ENDPOINTS.homebrew.createMagicItem();
    const page = await this.getPage(createUrl);
    const { security, authenticity } = this.tokens(page);
    const { finalUrl } = await this.postForm(
      createUrl,
      {
        "security-token": security,
        "authenticity-token": authenticity,
        "magic-item-type": String(typeId),
        "magic-item": String(baseItemId),
        description: "",
      },
      createUrl,
    );
    // The create redirects to either the slug-free editor (?id=…) or the canonical
    // /magic-items/{id}-{slug}/edit page; pull the numeric id out of whichever it is.
    const m = finalUrl.match(/[?&]id=(\d+)/) ?? finalUrl.match(/\/magic-items\/(\d+)-/);
    if (!m) {
      throw new Error(`Homebrew create did not redirect to an editor page (got ${finalUrl}).`);
    }
    return {
      itemId: Number(m[1]),
      entityTypeId: ENDPOINTS.homebrew.MAGIC_ITEM_ENTITY_TYPE_ID,
    };
  }

  /** Set the item's core fields (name, rarity, attunement, description, …). */
  async saveCoreFields(ref: HomebrewItemRef, fields: CoreItemFields): Promise<HomebrewItemRef> {
    const editUrl = ENDPOINTS.homebrew.editMagicItem(ref.itemId, ref.entityTypeId);
    const page = await this.getPage(editUrl);
    const { security, authenticity } = this.tokens(page);
    // The form posts to the canonical slug URL; read it straight off the form so we
    // never have to reconstruct the slug ourselves.
    const action = page.match(/<form[^>]*id="magic-item-form"[^>]*action="([^"]+)"/i);
    const saveUrl = action
      ? new URL(action[1], "https://www.dndbeyond.com").toString()
      : editUrl;

    const body: Record<string, string> = {
      "security-token": security,
      "authenticity-token": authenticity,
      name: fields.name,
      version: inputValue(page, "version"),
      rarity: String(fields.rarityId),
      // Preserve the base item's type/sub-type selections so validation passes.
      "item-base-type": selectedOption(page, "item-base-type"),
      type: selectedOption(page, "type"),
      "attunement-description": fields.attunementDescription ?? "",
      "item-description-type": inputValue(page, "item-description-type") || "1",
      "item-description-wysiwyg": fields.description ?? "",
      "item-description": fields.description ?? "",
      "number-of-charges": fields.charges != null ? String(fields.charges) : "",
      "charge-reset-condition": fields.chargeResetId != null ? String(fields.chargeResetId) : "",
      "charge-reset-description": fields.chargeResetDescription ?? "",
      notes: fields.notes ?? "",
      weight: fields.weight != null ? String(fields.weight) : "",
    };
    // Checkboxes are only submitted when checked.
    if (fields.requiresAttunement) body["requires-attunement"] = "y";
    if (fields.charges != null && fields.charges > 0) body["has-charges"] = "y";

    await this.postForm(saveUrl, body, saveUrl);
    return ref;
  }

  /** Add a single granted modifier (e.g. Bonus / Initiative / +1) to the item. */
  async addModifier(ref: HomebrewItemRef, mod: ModifierFields): Promise<void> {
    const url = ENDPOINTS.homebrew.createModifier(ref.itemId, ref.entityTypeId);
    const page = await this.getPage(url);
    const { security, authenticity } = this.tokens(page);
    const body: Record<string, string> = {
      "security-token": security,
      "authenticity-token": authenticity,
      "spell-modifier-type": String(mod.typeId),
      "spell-modifier-sub-type": mod.subTypeId != null ? String(mod.subTypeId) : "",
      "rpg-stat": "",
      "dice-count": mod.diceCount != null ? String(mod.diceCount) : "",
      "dice-value": mod.diceValue != null ? String(mod.diceValue) : "",
      "fixed-value": mod.fixedValue != null ? String(mod.fixedValue) : "",
      "additional-bonus-type": "",
      restriction: mod.restriction ?? "",
      "duration-interval": "",
      "duration-unit": "",
      "requires-attunement": mod.requiresAttunement ? "true" : "false",
    };
    await this.postForm(url, body, url);
  }
}
