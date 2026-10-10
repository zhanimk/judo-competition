import { IsEmail, IsString, Length, IsInt, Min, Max, Matches, IsUUID } from 'class-validator';
export class RegisterDto {
  @IsEmail() @Length(3, 200) email!: string;
  @IsString() @Length(2, 80) name!: string;
  @IsString() @Length(12, 128) password!: string;
}
export class LoginDto {
  @IsEmail() @Length(3, 200) email!: string;
  @IsString() @Length(1, 128) password!: string;
}
export class InviteDto {
  @IsUUID() id!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @Length(2, 80) label!: string;
  @IsInt() @Min(1) @Max(48) hours!: number;
  @Matches(/^[a-f0-9]{64}$/) token!: string;
}
export class AcceptDto {
  @Matches(/^[a-f0-9]{64}$/) token!: string;
  @IsString() @Length(2, 80) name!: string;
}
