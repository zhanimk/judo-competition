import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class ControlAccessQuery {
  @IsOptional() @IsUUID() deviceId?: string;
}
export class ControlAccessDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsUUID() deviceId!: string;
  @IsIn(['CLAIM', 'RELEASE', 'TAKEOVER']) type!: 'CLAIM' | 'RELEASE' | 'TAKEOVER';
  @ValidateIf((o: ControlAccessDto) => o.type === 'TAKEOVER' || o.reason !== undefined)
  @IsString()
  @Length(3, 500)
  reason?: string;
}
export class RevokeInvitationDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @Length(3, 500) reason!: string;
}
