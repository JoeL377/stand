import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { colorFor, createPersonColors } from "./util.ts";
import { PersonColors, useColorRegistry, usePersonColors } from "./PersonColors.tsx";

test("people whose ID hashes collide receive distinct colors, preserved as people join", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `person-${i}`);
  const colliders = ids.filter((id) => colorFor(id) === colorFor(ids[0]));
  const assign = createPersonColors();
  const before = colliders.map(assign);
  assert.equal(new Set(before).size, colliders.length);
  ids.forEach(assign);
  assert.deepEqual(colliders.map(assign), before);
  assert.equal(new Set(ids.map(assign)).size, ids.length);
});

test("fresh registries choose the same colors for the same ordered roster", () => {
  const first = createPersonColors();
  const second = createPersonColors();
  const ids = Array.from({ length: 25 }, (_, i) => `user-${i}`);
  assert.deepEqual(ids.map(first), ids.map(second));
});

test("faces and owner aliases share colors without merging people with the same first name", () => {
  function Child() {
    const color = usePersonColors();
    assert.equal(color("Joe"), color("joe-id"));
    assert.equal(color("Joe Liang"), color("joe-id"));
    assert.equal(color("Alex Chen"), color("alex-1"));
    assert.notEqual(color("alex-1"), color("alex-2"));
    assert.notEqual(color("Alex"), color("alex-1"));
    assert.notEqual(color("Alex"), color("alex-2"));
    return null;
  }
  function View() {
    const color = useColorRegistry("meeting", [
      { id: "joe-id", name: "Joe Liang" },
      { id: "alex-1", name: "Alex Chen" },
      { id: "alex-2", name: "Alex Smith" },
    ]);
    return createElement(PersonColors.Provider, { value: color }, createElement(Child));
  }
  renderToStaticMarkup(createElement(View));
});
