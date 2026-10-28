import { Type } from 'class-transformer';
import {
  IsUUID,
  IsBoolean,
  IsInt,
  Min,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Max,
  ValidateIf,
} from 'class-validator';
export class OfflineEventDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
  @IsIn([
    'START',
    'STOP',
    'GOLDEN',
    'TOKETA',
    'CONFIRM',
    'AWARD',
    'HOLD',
    'REVOKE',
    'ADVANCE',
    'RECOVER',
  ])
  type!: string;
  @ValidateIf((o: OfflineEventDto) => o.type === 'ADVANCE' || o.ms !== undefined)
  @IsInt()
  @Min(0)
  @Max(21600000)
  ms?: number;
  @ValidateIf((o: OfflineEventDto) => ['AWARD', 'HOLD'].includes(o.type) || o.side !== undefined)
  @IsIn(['WHITE', 'BLUE'])
  side?: 'WHITE' | 'BLUE';
  @ValidateIf((o: OfflineEventDto) => o.type === 'AWARD' || o.kind !== undefined)
  @IsIn(['YUKO', 'WAZA_ARI', 'IPPON', 'SHIDO'])
  kind?: 'YUKO' | 'WAZA_ARI' | 'IPPON' | 'SHIDO';
  @ValidateIf((o: OfflineEventDto) => o.type === 'REVOKE' || o.awardId !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  awardId?: string;
}
export class MatchCommandDto {
  @ValidateIf((o: MatchCommandDto) => o.skipRest !== undefined)
  @IsBoolean()
  skipRest?: boolean;
  @IsUUID() deviceId!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) controlGeneration!: number;
  @ValidateIf(
    (o: MatchCommandDto) =>
      (typeof o.type === 'string' && o.type.startsWith('OFFLINE_')) || o.sessionId !== undefined,
  )
  @IsUUID()
  sessionId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => OfflineEventDto)
  events?: OfflineEventDto[];
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
  @IsIn([
    'START',
    'STOP',
    'GOLDEN',
    'TOKETA',
    'CONFIRM',
    'AWARD',
    'HOLD',
    'REVOKE',
    'OFFLINE_OPEN',
    'OFFLINE_SYNC',
    'OFFLINE_RELEASE',
  ])
  type!: string;
  @ValidateIf((o: MatchCommandDto) => ['AWARD', 'HOLD'].includes(o.type) || o.side !== undefined)
  @IsIn(['WHITE', 'BLUE'])
  side?: 'WHITE' | 'BLUE';
  @ValidateIf((o: MatchCommandDto) => o.type === 'AWARD' || o.kind !== undefined)
  @IsIn(['YUKO', 'WAZA_ARI', 'IPPON', 'SHIDO'])
  kind?: 'YUKO' | 'WAZA_ARI' | 'IPPON' | 'SHIDO';
  @ValidateIf((o: MatchCommandDto) => o.type === 'REVOKE' || o.awardId !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  awardId?: string;
}
