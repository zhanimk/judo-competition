import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  Param,
  ParseUUIDPipe,
  Query,
  Header,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public, CurrentUser } from './auth.guard.js';
import { RegisterDto, LoginDto, InviteDto, AcceptDto } from './auth.dto.js';
import type { AuthRequest, CookieResponse, Principal } from './auth.types.js';
import { ControlAccessDto, ControlAccessQuery, RevokeInvitationDto } from './access.dto.js';
import { workRole } from './access-guards.js';
import { RuntimeConfig } from '../../infrastructure/runtime-config.js';
function cookie(res: CookieResponse, token: string, secure: boolean, logout = false) {
  res.setHeader(
    'Set-Cookie',
    `judo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : 28800}${secure ? '; Secure' : ''}`,
  );
  res.setHeader('Cache-Control', 'no-store');
}
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: RuntimeConfig,
  ) {}
  @Get('users') users(@CurrentUser() user: Principal) {
    return this.auth.users(user);
  }
  @Post('users') createUser(@CurrentUser() user: Principal, @Body() dto: RegisterDto) {
    return this.auth.register(dto, user);
  }
  @Public() @Post('login') async login(
    @Req() req: AuthRequest,
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const user = await this.auth.loginFromAddress(dto.email, dto.password, req.ip);
    cookie(res, await this.auth.session(user.id), this.config.cookieSecure);
    return { name: user.name, role: user.role, workRole: workRole(user.role) };
  }
  @Get('me') @Header('Cache-Control', 'no-store') me(@CurrentUser() user: Principal) {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      workRole: workRole(user.role),
      tatamiId: user.tatamiId,
    };
  }
  @Post('logout') async logout(
    @CurrentUser() user: Principal,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    await this.auth.logout(user);
    cookie(res, '', this.config.cookieSecure, true);
    return { ok: true };
  }
  @Get('tatamis/:id/invitations') @Header('Cache-Control', 'no-store') invites(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auth.invitations(user, id);
  }
  @Post('tatamis/:id/invitations') invite(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteDto,
  ) {
    return this.auth.invite(user, id, dto);
  }
  @Post('invitations/:id/revoke') revoke(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeInvitationDto,
  ) {
    return this.auth.revoke(user, id, dto);
  }
  @Public() @Post('invitations/accept') async accept(
    @Req() req: AuthRequest,
    @Body() dto: AcceptDto,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const result = await this.auth.acceptFromAddress(dto.token, dto.name, req.ip);
    cookie(res, result.token, this.config.cookieSecure);
    return { tatamiId: result.tatamiId, tournamentId: result.tournamentId };
  }
  @Get('tatamis/:id/control') @Header('Cache-Control', 'no-store') control(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ControlAccessQuery,
  ) {
    return this.auth.control(user, id, query.deviceId);
  }
  @Post('tatamis/:id/control') controlCommand(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ControlAccessDto,
  ) {
    return this.auth.controlCommand(user, id, dto);
  }
}
