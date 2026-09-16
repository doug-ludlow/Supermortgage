import { ApplyProduct } from "@/components/apply/ApplyProduct";

export const dynamic = "force-dynamic";

/** 32.19: the Apply product — the door, then the nine steps. The old Thread shell is not mounted. `?card=` lands on the card's step (docs/ux/18 §3.3). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { card } = await searchParams;
  const initialCard = typeof card === "string" && card ? card : undefined;
  return <ApplyProduct initialCard={initialCard} />;
}
