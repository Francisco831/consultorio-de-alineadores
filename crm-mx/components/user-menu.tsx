"use client";

import { signOut } from "@/lib/actions/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut } from "lucide-react";

const ROL_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  COUNTRY_MANAGER: "Country Manager",
  SALES_MANAGER: "Sales Manager",
  SALES: "Comercial",
  CLINICAL: "Clínica",
  VIEWER: "Solo lectura",
};

export function UserMenu({ nombre, rol }: { nombre: string; rol: string }) {
  const initials = nombre
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="outline-none">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {/* Base UI exige GroupLabel dentro de un Group (si no, crashea al abrir) */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="text-sm font-medium">{nombre}</div>
            <div className="text-xs font-normal text-muted-foreground">
              {ROL_LABELS[rol] ?? rol}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut()}>
          <LogOut className="mr-2 h-4 w-4" />
          Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
