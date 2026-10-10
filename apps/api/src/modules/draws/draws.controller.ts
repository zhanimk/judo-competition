import { Controller, Get, Post, Param, Body, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { DrawsService } from './draws.service.js';
import {
  AssignDto,
  DrawConfirmDto,
  DrawPreviewDto,
  DrawPublicationDto,
  TiebreakCommandDto,
} from './draws.dto.js';
@Controller()
export class DrawsController {
  constructor(private readonly draws: DrawsService) {}
  @Get('categories/:id/draw') get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.get(id, user);
  }
  @Post('categories/:id/draw/publication') publication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DrawPublicationDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.publication(id, dto, user);
  }
  @Get('categories/:id/draw/progress') progress(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.progress(id, user);
  }
  @Get('categories/:id/draw/tiebreak-impact') tiebreakImpact(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.tiebreakImpact(id, user);
  }
  @Post('categories/:id/draw/tiebreak') tiebreak(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TiebreakCommandDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.tiebreak(id, dto, user);
  }
  @Post('categories/:id/draw/preview') preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DrawPreviewDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.preview(id, dto, user);
  }
  @Post('categories/:id/draw/confirm') confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DrawConfirmDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.confirm(id, dto, user);
  }
  @Post('contests/:id/assign') assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.assign(id, dto, user);
  }
}
