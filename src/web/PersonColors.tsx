import { createContext, useContext, useMemo } from "react";
import { colorFor, createPersonColors } from "./util.ts";

type Person = { id: string; name: string };
export const PersonColors = createContext<(id: string) => string>(colorFor);
export const usePersonColors = () => useContext(PersonColors);

/** Share one assignment across faces, owners and transcript labels in a view. */
export function useColorRegistry(scope: string, people: Person[]) {
  const allocate = useMemo(() => createPersonColors(), [scope]);
  const ids = new Set(people.map((p) => p.id));
  [...ids].sort().forEach(allocate);
  const aliases = new Map<string, Set<string>>();
  for (const person of people) {
    for (const name of [person.name, person.name.split(/\s+/)[0]]) {
      const matches = aliases.get(name) ?? new Set<string>();
      matches.add(person.id);
      aliases.set(name, matches);
    }
  }
  return (id: string) => {
    const matches = aliases.get(id);
    return allocate(!ids.has(id) && matches?.size === 1 ? [...matches][0] : id);
  };
}
