import { IsEmail, IsString, Length, IsInt, Min, Max, Matches } from 'class-validator';
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
  @IsString() @Length(2, 80) label!: string;
  @IsInt() @Min(1) @Max(48) hours!: number;
}
export class AcceptDto {
  @Matches(/^[a-f0-9]{64}$/) token!: string;
  @IsString() @Length(2, 80) name!: string;
}
