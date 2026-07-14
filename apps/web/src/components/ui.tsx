import { AlertCircle, Inbox, LoaderCircle, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  className = "",
  variant = "default",
  busy = false,
  disabled = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "default" | "primary" | "quiet" | "danger";
  readonly busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${className}`.trim()}
      aria-busy={busy}
      disabled={busy || disabled}
    >
      {busy ? <LoaderCircle className="button-spinner" size={16} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <label className={`field ${className}`.trim()}>
      <span className="field-label">{label}</span>
      {children}
      {hint === undefined ? null : <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorNotice({
  message,
  onDismiss,
  action,
}: {
  readonly message: string;
  readonly onDismiss?: () => void;
  readonly action?: ReactNode;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <span>{message}</span>
      {action}
      {onDismiss === undefined ? null : (
        <button className="icon-button" type="button" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Inbox size={22} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function PageSkeleton({ rows = 4 }: { readonly rows?: number }) {
  return (
    <div className="page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading content</span>
      <span className="skeleton skeleton-title" />
      {Array.from({ length: rows }, (_, index) => (
        <span className="skeleton skeleton-row" key={index} />
      ))}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description === undefined ? null : <p className="page-description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}
