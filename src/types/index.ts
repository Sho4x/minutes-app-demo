export type MemberRole = 'chair' | 'vice' | 'exec' | 'member';

export interface Member {
  id: string;
  lastName: string;
  firstName: string;
  email: string;
  role: MemberRole;
  avatarColor: string;
}

export interface Organization {
  id: string;
  name: string;
  groupName: string;
}

export interface Talk {
  id: string;
  agendaId: string;
  speakerId: string;
  text: string;
  savedAt: string;
  isMerged: boolean;
}

export interface Agenda {
  id: string;
  sessionId: string;
  order: number;
  title: string;
  talks: Talk[];
}

export interface Session {
  id: string;
  organizationId: string;
  title: string;
  datetime: string;
  location: string;
  members: Member[]; // max 40
  agendas: Agenda[];
  status: 'draft' | 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
}
