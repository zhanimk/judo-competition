import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class DrawPreviewDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
}
export class DrawConfirmDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) version!: number;
}
export class DrawPublicationDto {
  @IsUUID() id!: string;
  @IsBoolean() published!: boolean;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
}

export class TiebreakCommandDto {
  @IsUUID() id!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) impactToken!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @IsIn(['ROUND_ROBIN']) procedure!: 'ROUND_ROBIN';
  @IsString() @MinLength(1) @MaxLength(128) parent!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) pool?: string;
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(128)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  members!: string[];
}

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
