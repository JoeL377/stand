// On a phone Stand is for following along: each screen shows what there is to read, and only the
// viewer's own things keep their buttons. Screens ask who that is here.

import { createContext, useContext, useEffect, useState } from "react";
import { useAuth } from "./auth.tsx";

export const PHONE_QUERY = "(max-width: 820px)";

export function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** The viewer's first name while they are on a phone, else null. */
export const PhoneViewer = createContext<string | null>(null);
export function usePhoneViewer(): string | null {
  const given = useContext(PhoneViewer);
  const phone = usePhone();
  const { user } = useAuth();
  return given ?? (phone ? user.name.split(" ")[0] : null);
}
