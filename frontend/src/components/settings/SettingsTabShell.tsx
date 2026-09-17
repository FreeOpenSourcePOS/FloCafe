"use client";

import React from "react";

export interface SettingsTabShellProps {
  title?: string;
  description?: string;
  maxWidth?: "form" | "wide" | "3xl" | "5xl";
  className?: string;
  children: React.ReactNode;
}

export function SettingsTabShell({
  title,
  description,
  maxWidth = "form",
  className = "",
  children,
}: SettingsTabShellProps) {
  const widthClass = maxWidth === "wide" || maxWidth === "5xl" ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className={`w-full space-y-6 ${widthClass} ${className}`.trim()}>
      {(title || description) && (
        <div className="space-y-1">
          {title && <h2 className="text-lg font-semibold text-foreground">{title}</h2>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
