import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
export class ControlCommandDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsIn(['MOVE', 'RESET', 'REOPEN', 'REMOVE', 'RELEASE_OFFLINE', 'EDIT_TIME']) type!:
    'MOVE' | 'RESET' | 'REOPEN' | 'REMOVE' | 'RELEASE_OFFLINE' | 'EDIT_TIME';
  @ValidateIf((o: ControlCommandDto) => o.type === 'EDIT_TIME' || o.phase !== undefined)
  @IsIn(['REGULAR', 'GOLDEN'])
  phase?: 'REGULAR' | 'GOLDEN';
  @ValidateIf((o: ControlCommandDto) => o.type === 'EDIT_TIME' || o.elapsedMs !== undefined)
  @IsInt()
  @Min(0)
  @Max(21600000)
  elapsedMs?: number;
  @IsOptional() @IsUUID() tatamiId?: string;
  @IsString() @Length(3, 300) reason!: string;
  @IsString() @Length(64, 64) impactToken!: string;
}
