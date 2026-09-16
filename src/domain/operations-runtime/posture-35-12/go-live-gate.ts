/** §35.12 rules 9–10: the go-live gate's day — `opened_on` + 28 calendar days (the parallel run's `planned_end_on`); a pure function the evaluator and the tools share. */
import { PARALLEL_RUN_DAYS, addCalendarDays } from "./types.ts";
export const goLiveNotBefore = (openedOn: string): string => addCalendarDays(openedOn, PARALLEL_RUN_DAYS);
