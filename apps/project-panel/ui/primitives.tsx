import type { ButtonHTMLAttributes, ReactNode } from "react";

export type BadgeColor = "info" | "success" | "warning" | "neutral";

export function Badge({
  color = "neutral",
  children,
}: {
  color?: BadgeColor;
  children: ReactNode;
}) {
  return (
    <span className="ak-badge" data-color={color}>
      {children}
    </span>
  );
}

export function Button({
  variant = "outline",
  className,
  type = "button",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "ghost" | "solid";
}) {
  return (
    <button
      type={type}
      className={className ? `ak-button ${className}` : "ak-button"}
      data-variant={variant}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Checkbox({
  size = "desktop",
  label,
  checked,
  onCheckedChange,
}: {
  size?: "desktop" | "compact";
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="ak-checkbox" data-size={size}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function DisclosureTrigger({
  expanded,
  onExpandedChange,
  label,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  label: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className ? `ak-disclosure-trigger ${className}` : "ak-disclosure-trigger"}
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
      {...rest}
    >
      <span className="ak-disclosure-chevron" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
      {label}
    </button>
  );
}

export function ExpandableContent({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  if (!expanded) return null;
  return <div className="ak-expandable-content">{children}</div>;
}

export function ProgressRing({
  percent,
  size = 20,
  strokeWidth = 2.5,
}: {
  percent: number;
  size?: number;
  strokeWidth?: number;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="ak-progress-ring"
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--edge)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
