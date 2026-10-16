import {
  IsOptional,
  IsString,
  Length,
  IsInt,
  Min,
  Max,
  IsIn,
  Matches,
  ValidateIf,
  IsUUID,
} from 'class-validator';
export class AdministrationCommandDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
}
export class CreateTournamentDto {
  @IsUUID() id!: string;
  @IsString() @Length(3, 120) name!: string;
  @IsString() @Length(2, 80) city!: string;
  @IsString() @Length(2, 160) venue!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
  @IsInt() @Min(1) @Max(32) tatamiCount!: number;
}
export class CreateCategoryDto extends AdministrationCommandDto {
  @IsOptional() @IsIn(['SINGLE_ELIMINATION', 'REPECHAGE', 'ROUND_ROBIN', 'MIXED']) format?: string;
  @IsString() @Length(2, 100) name!: string;
  @IsIn(['MALE', 'FEMALE']) gender!: string;
  @IsInt() @Min(1900) @Max(2100) birthYearFrom!: number;
  @IsInt() @Min(1900) @Max(2100) birthYearTo!: number;
  @ValidateIf((o: CreateCategoryDto) => o.maxWeightGrams !== null)
  @IsInt()
  @Min(1000)
  @Max(300000)
  maxWeightGrams!: number | null;
  @IsOptional() @IsInt() @Min(1000) @Max(300000) minWeightGrams?: number | null;
  @IsInt() @Min(30) @Max(1200) durationSeconds!: number;
}
export { SingleEntryCommitDto as CreateEntryDto } from '../roster/roster.dto.js';

export class TournamentInformationDto extends AdministrationCommandDto {
  @IsIn(['SAVE', 'PUBLISH', 'HIDE']) action!: 'SAVE' | 'PUBLISH' | 'HIDE';
  @IsString() @Length(0, 5000) description!: string;
  @IsString() @Length(0, 2000) weighing!: string;
  @IsString() @Length(0, 500) address!: string;
  @IsString() @Length(0, 2000) mapUrl!: string;
  @IsString() @Length(0, 700000) imageData!: string;
}
