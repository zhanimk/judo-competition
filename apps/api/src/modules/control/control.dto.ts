import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min, Max } from 'class-validator';
export class ControlCommandDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsIn(['MOVE', 'RESET', 'REOPEN', 'REMOVE', 'RELEASE_OFFLINE']) type!:
    'MOVE' | 'RESET' | 'REOPEN' | 'REMOVE' | 'RELEASE_OFFLINE';
  @IsOptional() @IsUUID() tatamiId?: string;
  @IsString() @Length(3, 300) reason!: string;
  @IsString() @Length(64, 64) impactToken!: string;
}
