// A person's face: their picture, or their initials on their colour. In its own file so a page that
// only shows faces doesn't load the call screen with it.
import { usePersonColors } from "./PersonColors.tsx";
import { initials } from "./util.ts";

export function Avatar({ id, name, picture, size = 44 }: { id: string; name: string; picture?: string | null; size?: number }) {
  const colorFor = usePersonColors();
  return picture ? (
    <img className="avatar" src={picture} alt="" style={{ width: size, height: size }} referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar" style={{ background: colorFor(id), width: size, height: size, fontSize: Math.max(11, size * 0.36) }}>
      {initials(name)}
    </div>
  );
}
