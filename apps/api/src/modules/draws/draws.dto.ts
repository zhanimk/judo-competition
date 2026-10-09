import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class AssignDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsUUID() tatamiId!: string;
}

export type AssignmentResult = {
  id: string;
  revision: number;
  status: 'READY';
  tatamiId: string;
  queueOrder: number;
  updatedAt: string;
};
