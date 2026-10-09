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
} from 'class-validator';
export class CreateTournamentDto {
  @IsString() @Length(3, 120) name!: string;
  @IsString() @Length(2, 80) city!: string;
  @IsString() @Length(2, 160) venue!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
  @IsInt() @Min(1) @Max(32) tatamiCount!: number;
}
export class CreateCategoryDto {
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
export class CreateEntryDto {
  @IsString() @Length(1, 80) firstName!: string;
  @IsString() @Length(1, 80) lastName!: string;
  @IsString() @Length(2, 120) club!: string;
  @IsInt() @Min(1900) @Max(2100) birthYear!: number;
}
