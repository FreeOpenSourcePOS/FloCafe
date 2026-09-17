"use client";

import React from "react";

export interface SettingsTabShellProps {
  title?: string;
  maxWidth?: "wide";
  children: React.ReactNode;
}

export function SettingsTabShell({
  title,
  maxWidth,
  children,
}: SettingsTabShellProps) {
  const widthClass = maxWidth === "wide" ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className={`w-full space-y-6 ${widthClass}`}>
      {title && (
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        </div>
      )}
      {children}
    </div>
  );
}
