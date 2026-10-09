import { Controller, Get, Post, Param, Body, ParseUUIDPipe } from '@nestjs/common';
import { IsInt, Min, IsBoolean } from 'class-validator';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { DrawsService } from './draws.service.js';
import { AssignDto } from './draws.dto.js';
class PublicationDto {
  @IsBoolean() published!: boolean;
  @IsInt() @Min(0) expectedRevision!: number;
}
class ConfirmDto {
  @IsInt() @Min(1) version!: number;
}
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
    @Body() dto: PublicationDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.publication(id, dto.published, dto.expectedRevision, user);
  }
  @Post('categories/:id/draw/preview') preview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.preview(id, user);
  }
  @Post('categories/:id/draw/confirm') confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.confirm(id, dto.version, user);
  }
  @Post('contests/:id/assign') assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDto,
    @CurrentUser() user: Principal,
  ) {
    return this.draws.assign(id, dto, user);
  }
}
