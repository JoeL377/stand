import { useEffect, useState } from "react";
import type { SpaceCost } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { callsLabel, dayBars, dayLabel, daysSummary, usdLabel } from "./spaceCost.ts";
import { taskName } from "./util.ts";

const WHERE = { calls: "In calls", chat: "In chat", between: "Between meetings" };

/** What Stand's Claude calls for the space cost lately, by where they ran, by pass and by day. Only its admins see it. */
export function CostPanel({ roomId }: { roomId: string }) {
  const [days, setDays] = useState(30);
  const [cost, setCost] = useState<SpaceCost | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    // The numbers on screen stay until the new range arrives.
    api.spaceCost(roomId, days).then(
      (c) => active && (setCost(c), setError("")),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [roomId, days]);

  if (!cost) return error ? <p className="error">{error}</p> : null;
  const bars = dayBars(cost.days);

  return (
    <section className="cost-panel">
      <div className="cost-head">
        <h3>What Stand spent</h3>
        <label className="cost-range">
          <select aria-label="Cost range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
      </div>
      <p className="muted small">Claude calls for this space, at list prices. An estimate, not the invoice.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!cost.calls ? (
        <p className="muted small">Nothing in this range yet. Stand counts what it does between meetings from the day this was added.</p>
      ) : (
        <>
          <p className="cost-total">
            <strong>{usdLabel(cost.usd)}</strong> <span className="muted">· {callsLabel(cost.calls)}</span>
          </p>
          {cost.groups.map((g) => (
            <div className="cost-group" key={g.where}>
              <div className="cost-line cost-group-head">
                <span>{WHERE[g.where]}</span>
                <span>{usdLabel(g.usd)}</span>
                <span className="muted">{callsLabel(g.calls)}</span>
              </div>
              {g.where === "between" && <p className="muted small">What Stand does for the space, not for one meeting. Some of it runs as a meeting starts or ends.</p>}
              {g.tasks.map((t) => (
                <div className="cost-line" key={t.task}>
                  <span>{taskName(t.task)}</span>
                  <span>{usdLabel(t.usd)}</span>
                  <span className="muted">{callsLabel(t.calls)}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="cost-days" role="img" aria-label={daysSummary(cost.days)}>
            {bars.map((b) => (
              <span className="cost-day" key={b.day} title={b.title}>
                <span className={b.height ? "cost-bar" : "cost-bar none"} style={b.height ? { height: `${b.height}%` } : undefined}>
                  {b.between > 0 && <span className="cost-bar-between" style={{ height: `${b.between}%` }} />}
                </span>
              </span>
            ))}
          </div>
          <div className="cost-days-ends muted small" aria-hidden="true">
            <span>{dayLabel(cost.days[0].day)}</span>
            <span>{dayLabel(cost.days.at(-1)!.day)}</span>
          </div>
        </>
      )}
    </section>
  );
}
