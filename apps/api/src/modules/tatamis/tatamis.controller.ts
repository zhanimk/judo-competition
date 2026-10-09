import { Public, CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { Controller, Get, Param, ParseUUIDPipe, Req, Header } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.types.js';
import { TatamisService } from './tatamis.service.js';
@Controller('tournaments/:tournamentId/tatamis')
export class TatamisController {
  constructor(private readonly service: TatamisService) {}
  @Get() list(@Param('tournamentId', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.service.list(id, user);
  }
  @Public() @Get(':tatamiId') @Header('Cache-Control', 'no-store') get(
    @Param('tournamentId', ParseUUIDPipe) id: string,
    @Param('tatamiId', ParseUUIDPipe) tatamiId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.get(id, tatamiId, req.headers.cookie);
  }
}
