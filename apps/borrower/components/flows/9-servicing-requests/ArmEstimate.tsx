"use client";

import type { ArmEstimate } from "@/lib/types/record";
import { copy } from "@/lib/copy";
import { formatDate, formatMoney, formatRate } from "@/lib/format";

/**
 * 32.9 §3 / 7.3 — the Numbers rows an ARM shows once the initial (d) notice is sent: the estimated new payment and
 * rate the engine disclosed on `arm.initial_notice.sent`, and the date the change takes effect. The shell never
 * recomputes a figure: every value is the record's (`numbers.arm_estimate`), the sentence is the library's `arm.change`.
 */
export function ArmEstimateRows({ estimate }: { estimate: ArmEstimate }) {
  const changeDate = estimate.first_new_payment_due ?? estimate.change_on;
  const dateLabel = changeDate ? formatDate(`${changeDate}T12:00:00Z`, "UTC") : "";
  const money = estimate.estimated_pi_cents !== null ? formatMoney(estimate.estimated_pi_cents) : "";
  return (
    <>
      <dt>{estimate.basis === "actual" ? "New payment" : "Estimated new payment"}</dt>
      <dd data-testid="arm-estimate" data-basis={estimate.basis}>
        {money}
        {changeDate ? (
          <>
            {" "}from <time dateTime={changeDate}>{dateLabel}</time>
          </>
        ) : null}
        <span className="sm-source"> · {copy("arm.change", { date: dateLabel, money })}</span>
      </dd>
      {estimate.estimated_rate !== null ? (
        <>
          <dt>{estimate.basis === "actual" ? "New rate" : "Estimated new rate"}</dt>
          <dd data-testid="arm-estimate-rate">{formatRate(estimate.estimated_rate)}</dd>
        </>
      ) : null}
    </>
  );
}
