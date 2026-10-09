import { Controller, Post, Get, Body, Req, Res, Param, ParseUUIDPipe } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public, CurrentUser } from './auth.guard.js';
import { RegisterDto, LoginDto, InviteDto, AcceptDto } from './auth.dto.js';
import type { AuthRequest, CookieResponse, Principal } from './auth.types.js';
function cookie(res: CookieResponse, token: string, logout = false) {
  res.setHeader(
    'Set-Cookie',
    `judo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : 28800}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`,
  );
  res.setHeader('Cache-Control', 'no-store');
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Get('users') users(@CurrentUser() user: Principal) {
    return this.auth.users(user);
  }
  @Post('users') createUser(@CurrentUser() user: Principal, @Body() dto: RegisterDto) {
    this.auth.admin(user);
    return this.auth.register(dto.email, dto.name, dto.password);
  }
  @Public() @Post('login') async login(
    @Req() req: AuthRequest,
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    this.auth.limit('login:' + req.ip);
    const user = await this.auth.login(dto.email, dto.password);
    cookie(res, await this.auth.session(user.id));
    return { name: user.name, role: user.role };
  }
  @Get('me') me(@CurrentUser() user: Principal) {
    return { id: user.id, name: user.name, role: user.role, tatamiId: user.tatamiId };
  }
  @Post('logout') async logout(
    @CurrentUser() user: Principal,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    await this.auth.logout(user.sessionId);
    cookie(res, '', true);
    return { ok: true };
  }
  @Get('tatamis/:id/invitations') invites(
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
    return this.auth.invite(user, id, dto.label, dto.hours);
  }
  @Post('invitations/:id/revoke') revoke(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auth.revoke(user, id);
  }
  @Public() @Post('invitations/accept') async accept(
    @Req() req: AuthRequest,
    @Body() dto: AcceptDto,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    this.auth.limit('accept:' + req.ip);
    const result = await this.auth.accept(dto.token, dto.name);
    cookie(res, result.token);
    return { tatamiId: result.tatamiId, tournamentId: result.tournamentId };
  }
  @Get('tatamis/:id/control') control(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auth.control(user, id);
  }
}
