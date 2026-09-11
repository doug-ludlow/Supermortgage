import type { CardInstance, CardKind, ResolveRequest } from "@/lib/types/cards";

/** Props every card component receives. `onResolve` POSTs /v1/borrower/cards/{id}/resolve through lib/api. */
export type CardComponentProps<K extends CardKind> = {
  card: CardInstance<K>;
  timezone: string;
  onResolve: (req: ResolveRequest) => Promise<void> | void;
  /** Open a related card / document (Record deep-links, checklist items). */
  onOpen?: (target: { card_instance_id?: string; document_id?: string }) => void;
  /** Vendor launch hook (ConnectCard / HandoffCard). In fixtures mode this is the FAKE vendor. */
  onLaunchVendor?: (vendor: string, card_instance_id: string) => Promise<{ vendor_session_id: string }>;
  /** Attach/upload hook (UploadCard). */
  onUpload?: (file: File, document_class: string) => Promise<{ document_id: string }>;
  busy?: boolean;
  error?: string;
};
