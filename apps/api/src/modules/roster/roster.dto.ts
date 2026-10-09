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
} from 'class-validator';

export class RosterEntryDto {
  @IsString() @Length(1, 80) firstName!: string;
  @IsString() @Length(1, 80) lastName!: string;
  @IsInt() @Min(1900) @Max(2100) birthYear!: number;
  @IsIn(['MALE', 'FEMALE']) gender!: 'MALE' | 'FEMALE';
  @IsUUID() categoryId!: string;
  @IsOptional() @IsBoolean() duplicateConfirmed?: boolean;
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
