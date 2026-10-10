import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PUBLISHED_PROTOCOL_KINDS = ['DRAW', 'PARTICIPANTS', 'TEAMS'] as const;
export type PublishedProtocolKind = (typeof PUBLISHED_PROTOCOL_KINDS)[number];
export class ProtocolHistoryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) beforeVersion?: number;
}

export class ProtocolCreateDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) expectedRevision!: number;
  @IsString() @Length(3, 500) reason!: string;
  @IsIn(PUBLISHED_PROTOCOL_KINDS) kind!: PublishedProtocolKind;
  @IsIn(['ru', 'kk']) lang!: 'ru' | 'kk';
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds?: string[];
}

export class ProtocolVisibilityDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) expectedRevision!: number;
  @IsString() @Length(3, 500) reason!: string;
  @IsIn(['PUBLISH', 'UNPUBLISH']) type!: 'PUBLISH' | 'UNPUBLISH';
  @IsString() @Length(64, 64) sha256!: string;
}
