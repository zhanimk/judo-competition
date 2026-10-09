import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
  registerDecorator,
} from 'class-validator';

export class EntryFieldsDto {
  @IsString() @Length(1, 80) firstName!: string;
  @IsString() @Length(1, 80) lastName!: string;
  @IsInt() @Min(1900) @Max(2100) birthYear!: number;
  @IsIn(['MALE', 'FEMALE']) gender!: 'MALE' | 'FEMALE';
  @IsUUID() categoryId!: string;
  @IsOptional() @IsBoolean() duplicateConfirmed?: boolean;
}
export class RosterEntryDto extends EntryFieldsDto {
  @IsOptional() @IsUUID() athleteId?: string;
}
export class RosterPreviewDto {
  @IsUUID() clubId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RosterEntryDto)
  entries!: RosterEntryDto[];
}
export class RosterCommitDto extends RosterPreviewDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
}
export class CreateClubDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @Length(2, 120) name!: string;
}

function TrimmedReason() {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'trimmedReason',
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          [...value.trim()].length >= 3 &&
          [...value.trim()].length <= 500,
        defaultMessage: () => 'reason must contain 3–500 characters after trimming',
      },
    });
}
export class EntryPreviewDto extends EntryFieldsDto {
  @IsUUID() clubId!: string;
}
export class EntryUpdateDto extends EntryPreviewDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @TrimmedReason() reason!: string;
}
export class EntryArchiveDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @TrimmedReason() reason!: string;
}
export class EntryRestoreDto extends EntryArchiveDto {
  @IsOptional() @IsBoolean() duplicateConfirmed?: boolean;
}
export class EntryIdentityPreviewDto {
  @IsUUID() athleteId!: string;
}
export class EntryIdentityBindDto extends EntryArchiveDto {
  @IsUUID() athleteId!: string;
}
export class AthleteDirectoryQueryDto {
  @IsOptional() @IsString() @Length(0, 160) query?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
