// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderObject, renderTemplate } from "../../src/sources/command.js";

describe("renderTemplate", () => {
  it("substitutes a top-level {{key}} from the input object", () => {
    expect(renderTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  it("substitutes nested {{a.b.c}} via dot path", () => {
    expect(renderTemplate("v={{x.y.z}}", { x: { y: { z: 42 } } })).toBe("v=42");
  });

  it("tolerates surrounding whitespace inside the braces", () => {
    expect(renderTemplate("{{   name   }}", { name: "ok" })).toBe("ok");
  });

  it("substitutes the same placeholder multiple times", () => {
    expect(renderTemplate("{{n}}-{{n}}-{{n}}", { n: 1 })).toBe("1-1-1");
  });

  it("renders an empty string when the key is missing", () => {
    expect(renderTemplate("a={{missing}}b", {})).toBe("a=b");
  });

  it("renders an empty string when a nested key dereferences null", () => {
    expect(renderTemplate("v={{x.y.z}}", { x: null })).toBe("v=");
  });

  it("returns the template untouched when input is not an object", () => {
    expect(renderTemplate("{{x}}", "string")).toBe("{{x}}");
    expect(renderTemplate("{{x}}", null)).toBe("{{x}}");
    expect(renderTemplate("{{x}}", undefined)).toBe("{{x}}");
  });

  it("coerces non-string scalars to string", () => {
    expect(renderTemplate("n={{n}}, b={{b}}", { n: 42, b: true })).toBe("n=42, b=true");
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderTemplate("plain text", { name: "x" })).toBe("plain text");
  });
});

describe("renderObject", () => {
  it("renders strings inside an object recursively", () => {
    expect(
      renderObject({ url: "/v1/{{repo}}", title: "{{rule}}" }, { repo: "foo", rule: "bar" }),
    ).toEqual({ url: "/v1/foo", title: "bar" });
  });

  it("renders strings inside arrays", () => {
    expect(renderObject(["{{a}}", "{{b}}", "literal"], { a: "1", b: "2" })).toEqual([
      "1",
      "2",
      "literal",
    ]);
  });

  it("recurses through nested objects + arrays", () => {
    const tmpl = {
      headers: { Authorization: "Bearer {{token}}" },
      body: { items: [{ name: "{{name}}", count: 3 }] },
    };
    expect(renderObject(tmpl, { token: "tok", name: "n1" })).toEqual({
      headers: { Authorization: "Bearer tok" },
      body: { items: [{ name: "n1", count: 3 }] },
    });
  });

  it("preserves non-string scalars (numbers, booleans, null)", () => {
    expect(renderObject({ n: 1, b: true, x: null }, { irrelevant: 0 })).toEqual({
      n: 1,
      b: true,
      x: null,
    });
  });

  it("returns scalar inputs unchanged", () => {
    expect(renderObject(42, {})).toBe(42);
    expect(renderObject(false, {})).toBe(false);
    expect(renderObject(null, {})).toBeNull();
  });

  it("renders a top-level string template", () => {
    expect(renderObject("hello {{name}}", { name: "world" })).toBe("hello world");
  });
});
